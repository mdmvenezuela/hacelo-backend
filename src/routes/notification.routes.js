const express = require('express');
const { query } = require('../config/db');
const { authenticate } = require('../middlewares/auth.middleware');
const router = express.Router();

// GET /notifications — Listar notificaciones del usuario
router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 30, unreadOnly } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let condition = 'WHERE user_id = $1';
    if (unreadOnly === 'true') condition += ' AND is_read = false';
    const { rows } = await query(`
      SELECT * FROM notifications
      ${condition}
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.user.id, parseInt(limit), offset]);
    const { rows: [{ count }] } = await query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
      [req.user.id]
    );
    res.json({ success: true, data: rows, unreadCount: parseInt(count) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /notifications/:id/read — Marcar una como leída
router.patch('/:id/read', authenticate, async (req, res) => {
  try {
    await query(
      'UPDATE notifications SET is_read = true, read_at = NOW() WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /notifications/read-all — Marcar todas como leídas
router.patch('/read-all', authenticate, async (req, res) => {
  try {
    await query(
      'UPDATE notifications SET is_read = true, read_at = NOW() WHERE user_id = $1 AND is_read = false',
      [req.user.id]
    );
    res.json({ success: true, message: 'Todas marcadas como leídas' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /notifications/token — Guardar push token del dispositivo 🔔 NUEVO
router.post('/token', authenticate, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'Token requerido' });
    await query('UPDATE users SET push_token = $1 WHERE id = $2', [token, req.user.id]);
    res.json({ success: true, message: 'Token guardado' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /notifications/token — Borrar push token al cerrar sesión 🔔 NUEVO
router.delete('/token', authenticate, async (req, res) => {
  try {
    await query('UPDATE users SET push_token = NULL WHERE id = $1', [req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;