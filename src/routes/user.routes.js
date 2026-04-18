const express = require('express');
const bcrypt  = require('bcryptjs');
const { query } = require('../config/db');
const { authenticate } = require('../middlewares/auth.middleware');

const router = express.Router();

// ── GET /users/me ─────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const { rows: [user] } = await query(`
      SELECT
        u.id, u.email, u.full_name, u.phone, u.role,
        u.avatar_url, u.is_active, u.is_verified, u.zone_id, u.created_at,
        z.name  AS zone_name,
        z.state AS zone_state,
        pp.kyc_status, pp.visit_price, pp.rating_avg,
        pp.orders_completed, pp.points, pp.level, pp.bio, pp.city,
        COALESCE(pp.is_verified, false) AS provider_is_verified
      FROM users u
      LEFT JOIN zones z ON z.id = u.zone_id
      LEFT JOIN provider_profiles pp ON pp.user_id = u.id
      WHERE u.id = $1
    `, [req.user.id]);

    if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });

    user.is_verified = user.is_verified === true || user.provider_is_verified === true;
    delete user.provider_is_verified;

    const { rows: [wallet] } = await query(
      'SELECT balance, blocked_balance FROM wallets WHERE user_id = $1',
      [req.user.id]
    );

    res.json({ success: true, data: { user, wallet: wallet || { balance: 0, blocked_balance: 0 } } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /users/me — Actualizar perfil ───────────────────────
router.patch('/me', authenticate, async (req, res) => {
  try {
    const { fullName, phone, avatarUrl } = req.body;
    await query(`
      UPDATE users SET
        full_name  = COALESCE($1, full_name),
        phone      = COALESCE($2, phone),
        avatar_url = COALESCE($3, avatar_url)
      WHERE id = $4
    `, [fullName ?? null, phone ?? null, avatarUrl ?? null, req.user.id]);

    res.json({ success: true, message: 'Perfil actualizado' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /users/me/password — Cambiar contraseña ─────────────
router.patch('/me/password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword)
      return res.status(400).json({ success: false, message: 'currentPassword y newPassword son requeridos' });

    // Validar fortaleza de la contraseña nueva
    if (newPassword.length < 8)
      return res.status(400).json({ success: false, message: 'La contraseña debe tener al menos 8 caracteres' });
    if (!/[0-9]/.test(newPassword))
      return res.status(400).json({ success: false, message: 'La contraseña debe contener al menos un número' });
    if (!/[^a-zA-Z0-9]/.test(newPassword))
      return res.status(400).json({ success: false, message: 'La contraseña debe contener al menos un carácter especial' });

    // Obtener hash actual
    const { rows: [user] } = await query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });

    // Verificar contraseña actual
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid)
      return res.status(401).json({ success: false, message: 'La contraseña actual es incorrecta' });

    // Hashear y guardar nueva contraseña
    const hash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);

    res.json({ success: true, message: 'Contraseña actualizada correctamente' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;