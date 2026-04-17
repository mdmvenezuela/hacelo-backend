const express = require('express');
const { query } = require('../config/db');
const { authenticate, requireProvider } = require('../middlewares/auth.middleware');

const router = express.Router();

// ── GET /providers — Buscar ──────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { categorySlug, city = 'Cabimas', search, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [city];
    let joins = '';
    let cond  = 'pp.is_available = true AND u.is_active = true AND pp.is_verified = true';

    if (categorySlug) {
      joins += ' JOIN provider_services ps ON ps.provider_id = pp.id JOIN categories c ON c.id = ps.category_id';
      params.push(categorySlug);
      cond += ` AND c.slug = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      cond += ` AND (u.full_name ILIKE $${params.length} OR pp.bio ILIKE $${params.length})`;
    }

    const { rows } = await query(`
      SELECT DISTINCT u.id, u.full_name, u.avatar_url,
        pp.bio, pp.visit_price, pp.level, pp.rating_avg, pp.rating_count,
        pp.orders_completed, pp.is_verified, pp.coverage_zones, pp.city, pp.is_available
      FROM provider_profiles pp
      JOIN users u ON u.id = pp.user_id ${joins}
      WHERE ${cond} AND pp.city = $1
      ORDER BY pp.rating_avg DESC, pp.orders_completed DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, parseInt(limit), offset]);

    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /providers/:id — Perfil público con reseñas reales ───
router.get('/:id', async (req, res) => {
  try {
    const userId = req.params.id;

    // Datos del proveedor
    const { rows: [provider] } = await query(`
      SELECT u.id, u.full_name, u.avatar_url, u.is_verified,
             pp.id as profile_id, pp.bio, pp.visit_price, pp.level, pp.rating_avg,
             pp.rating_count, pp.orders_completed, pp.years_experience,
             pp.coverage_zones, pp.city, pp.state, pp.is_available, pp.is_verified as pp_verified,
             pp.kyc_status
      FROM provider_profiles pp
      JOIN users u ON u.id = pp.user_id
      WHERE u.id = $1
    `, [userId]);

    if (!provider) return res.status(404).json({ success: false, message: 'Proveedor no encontrado' });

    // Servicios con categoría
    const { rows: services } = await query(`
      SELECT ps.id, ps.title, ps.description, ps.skills, ps.category_id,
             c.name as category_name, c.icon as category_icon, c.slug as category_slug
      FROM provider_services ps
      JOIN categories c ON c.id = ps.category_id
      WHERE ps.provider_id = $1 AND ps.is_active = true
    `, [provider.profile_id]);

    // Galería
    const { rows: gallery } = await query(`
      SELECT * FROM provider_gallery WHERE provider_id = $1 ORDER BY sort_order
    `, [provider.profile_id]);

    // ── Reseñas REALES de órdenes completadas ────────────────
    const { rows: reviews } = await query(`
      SELECT
        o.client_rating, o.client_review, o.client_rated_at,
        u.full_name as client_name, u.avatar_url as client_avatar
      FROM orders o
      JOIN users u ON u.id = o.client_id
      WHERE o.provider_id = $1
        AND o.client_rating IS NOT NULL
        AND o.status IN ('confirmed')
      ORDER BY o.client_rated_at DESC
      LIMIT 20
    `, [userId]);

    res.json({
      success: true,
      data: { ...provider, services, gallery, reviews },
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── PATCH /providers/me/profile ───────────────────────────────
router.patch('/me/profile', authenticate, requireProvider, async (req, res) => {
  try {
    const { bio, visitPrice, coverageZones, yearsExperience } = req.body;
    await query(`
      UPDATE provider_profiles
      SET bio = COALESCE($1, bio),
          visit_price = COALESCE($2, visit_price),
          coverage_zones = COALESCE($3, coverage_zones),
          years_experience = COALESCE($4, years_experience)
      WHERE user_id = $5
    `, [bio, visitPrice, coverageZones, yearsExperience, req.user.id]);
    res.json({ success: true, message: 'Perfil actualizado' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── PATCH /providers/me/availability ─────────────────────────
router.patch('/me/availability', authenticate, requireProvider, async (req, res) => {
  try {
    const { isAvailable } = req.body;
    const { rows: [pp] } = await query(
      'UPDATE provider_profiles SET is_available = $1 WHERE user_id = $2 RETURNING is_available',
      [isAvailable, req.user.id]
    );
    res.json({ success: true, data: { isAvailable: pp.is_available } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /providers/me/services — Crear/actualizar servicio ───
router.post('/me/services', authenticate, requireProvider, async (req, res) => {
  try {
    const { categoryId, title, description, skills } = req.body;
    if (!categoryId || !title) return res.status(400).json({ success: false, message: 'Categoría y título son requeridos' });

    const { rows: [pp] } = await query('SELECT id FROM provider_profiles WHERE user_id = $1', [req.user.id]);
    if (!pp) return res.status(404).json({ success: false, message: 'Perfil no encontrado' });

    const { rows: [service] } = await query(`
      INSERT INTO provider_services (provider_id, category_id, title, description, skills)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (provider_id, category_id)
      DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, skills = EXCLUDED.skills
      RETURNING *
    `, [pp.id, categoryId, title, description || null, skills || []]);

    res.json({ success: true, data: service });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /providers/me/schedule — Guardar horario ────────────
router.post('/me/schedule', authenticate, requireProvider, async (req, res) => {
  try {
    const { schedule } = req.body;
    if (!schedule) return res.status(400).json({ success: false, message: 'Schedule requerido' });

    const { rows: [pp] } = await query('SELECT id FROM provider_profiles WHERE user_id = $1', [req.user.id]);
    await query('DELETE FROM provider_schedule WHERE provider_id = $1', [pp.id]);

    for (const [day, slot] of Object.entries(schedule)) {
      if (slot.active) {
        await query(`
          INSERT INTO provider_schedule (provider_id, day_of_week, start_time, end_time, is_available)
          VALUES ($1, $2, $3, $4, true)
        `, [pp.id, parseInt(day), slot.start, slot.end]);
      }
    }
    res.json({ success: true, message: 'Horario actualizado' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
