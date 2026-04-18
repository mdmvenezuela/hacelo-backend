const express = require('express');
const { query } = require('../config/db');
const { authenticate, requireProvider } = require('../middlewares/auth.middleware');

const router = express.Router();

// ── GET /providers — Buscar proveedores ──────────────────────
// Filtra por zona del cliente autenticado si viene token,
// o por zoneId explícito en query params
router.get('/', async (req, res) => {
  try {
    const { categorySlug, search, page = 1, limit = 20, zoneId } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Intentar leer el usuario del token para obtener su zona
    let clientZoneId = zoneId || null;
    const authHeader = req.headers.authorization;
    if (!clientZoneId && authHeader?.startsWith('Bearer ')) {
      try {
        const jwt     = require('jsonwebtoken');
        const payload = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
        if (payload.userId) {
          const { rows: [u] } = await query(
            'SELECT zone_id FROM users WHERE id = $1', [payload.userId]
          );
          clientZoneId = u?.zone_id || null;
        }
      } catch { /* token inválido o expirado — continuar sin filtro de zona */ }
    }

    const params = [];
    let joins = '';
    const conditions = [
      'pp.is_available = true',
      'u.is_active = true',
      'pp.is_verified = true',
    ];

    // Filtrar por zona — mismo municipio que el cliente
    if (clientZoneId) {
      params.push(clientZoneId);
      conditions.push(`u.zone_id = $${params.length}`);
    }

    if (categorySlug) {
      joins += ' JOIN provider_services ps ON ps.provider_id = pp.id JOIN categories c ON c.id = ps.category_id';
      params.push(categorySlug);
      conditions.push(`c.slug = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(u.full_name ILIKE $${params.length} OR pp.bio ILIKE $${params.length})`);
    }

    const where = conditions.join(' AND ');

    const { rows } = await query(`
      SELECT DISTINCT
        u.id, u.full_name, u.avatar_url,
        pp.bio, pp.visit_price, pp.level, pp.rating_avg, pp.rating_count,
        pp.orders_completed, pp.is_verified, pp.coverage_zones, pp.city, pp.is_available,
        z.name AS zone_name, z.state AS zone_state
      FROM provider_profiles pp
      JOIN users u ON u.id = pp.user_id
      LEFT JOIN zones z ON z.id = u.zone_id
      ${joins}
      WHERE ${where}
      ORDER BY pp.rating_avg DESC, pp.orders_completed DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, parseInt(limit), offset]);

    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /providers/:id — Perfil público con reseñas reales ───
router.get('/:id', async (req, res) => {
  try {
    const userId = req.params.id;

    const { rows: [provider] } = await query(`
      SELECT u.id, u.full_name, u.avatar_url, u.is_verified,
             pp.id as profile_id, pp.bio, pp.visit_price, pp.level, pp.rating_avg,
             pp.rating_count, pp.orders_completed, pp.years_experience,
             pp.coverage_zones, pp.city, pp.state, pp.is_available,
             pp.is_verified as pp_verified, pp.kyc_status,
             z.name AS zone_name, z.state AS zone_state
      FROM provider_profiles pp
      JOIN users u ON u.id = pp.user_id
      LEFT JOIN zones z ON z.id = u.zone_id
      WHERE u.id = $1
    `, [userId]);

    if (!provider) return res.status(404).json({ success: false, message: 'Proveedor no encontrado' });

    const { rows: services } = await query(`
      SELECT ps.id, ps.title, ps.description, ps.skills, ps.category_id,
             c.name as category_name, c.icon as category_icon, c.slug as category_slug
      FROM provider_services ps
      JOIN categories c ON c.id = ps.category_id
      WHERE ps.provider_id = $1 AND ps.is_active = true
    `, [provider.profile_id]);

    const { rows: gallery } = await query(`
      SELECT * FROM provider_gallery WHERE provider_id = $1 ORDER BY sort_order
    `, [provider.profile_id]);

    const { rows: reviews } = await query(`
      SELECT o.client_rating, o.client_review, o.client_rated_at,
             u.full_name as client_name, u.avatar_url as client_avatar
      FROM orders o
      JOIN users u ON u.id = o.client_id
      WHERE o.provider_id = $1
        AND o.client_rating IS NOT NULL
        AND o.status = 'confirmed'
      ORDER BY o.client_rated_at DESC
      LIMIT 20
    `, [userId]);

    res.json({ success: true, data: { ...provider, services, gallery, reviews } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /providers/me/profile ───────────────────────────────
router.patch('/me/profile', authenticate, requireProvider, async (req, res) => {
  try {
    const { bio, visitPrice, coverageZones, yearsExperience } = req.body;
    await query(`
      UPDATE provider_profiles SET
        bio              = COALESCE($1, bio),
        visit_price      = COALESCE($2, visit_price),
        coverage_zones   = COALESCE($3, coverage_zones),
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

// ── POST /providers/me/services — Reemplaza TODOS los servicios del proveedor
// Recibe: { services: [{ categoryId, title, description, skills }] }
router.post('/me/services', authenticate, requireProvider, async (req, res) => {
  try {
    console.log('📦 body recibido:', JSON.stringify(req.body));
    const { services } = req.body;

    if (!Array.isArray(services) || services.length === 0)
      return res.status(400).json({ success: false, message: 'Envía al menos un servicio' });

    for (const svc of services) {
      // Aceptar tanto categoryId (camelCase desde app) como category_id (snake_case)
      const catId = svc.categoryId || svc.category_id;
      if (!catId || !svc.title?.trim())
        return res.status(400).json({
          success: false,
          message: `Servicio "${svc.title || ''}" — categoryId: ${catId || 'vacío'}, title: "${svc.title || 'vacío'}"`,
        });
    }

    const { rows: [pp] } = await query(
      'SELECT id FROM provider_profiles WHERE user_id = $1', [req.user.id]
    );
    if (!pp) return res.status(404).json({ success: false, message: 'Perfil no encontrado' });

    // Eliminar todos los servicios actuales y reinsertar
    // (más simple y confiable que intentar hacer diff)
    await query('DELETE FROM provider_services WHERE provider_id = $1', [pp.id]);

    const inserted = [];
    for (const svc of services) {
      const catId = svc.categoryId || svc.category_id;
      const { rows: [row] } = await query(`
        INSERT INTO provider_services (provider_id, category_id, title, description, skills)
        VALUES ($1, $2, $3, $4, $5) RETURNING *
      `, [pp.id, catId, svc.title.trim(), svc.description?.trim() || null, svc.skills || []]);
      inserted.push(row);
    }

    res.json({ success: true, data: inserted });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /providers/me/schedule ───────────────────────────────
router.post('/me/schedule', authenticate, requireProvider, async (req, res) => {
  try {
    const { schedule } = req.body;
    if (!schedule) return res.status(400).json({ success: false, message: 'Schedule requerido' });

    const { rows: [pp] } = await query(
      'SELECT id FROM provider_profiles WHERE user_id = $1', [req.user.id]
    );
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