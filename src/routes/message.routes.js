const express = require('express');
const { query } = require('../config/db');
const { authenticate } = require('../middlewares/auth.middleware');
const { emitToOrder, getIO } = require('../config/socket');

const router = express.Router();

// ── GET /messages/:orderId — Historial de mensajes ───────────
router.get('/:orderId', authenticate, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.id;

    // Verificar que el usuario pertenece a esta orden
    const { rows: [order] } = await query(
      'SELECT id, client_id, provider_id FROM orders WHERE id = $1',
      [orderId]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    if (order.client_id !== userId && order.provider_id !== userId) {
      return res.status(403).json({ success: false, message: 'Sin acceso a esta conversación' });
    }

    const { rows: messages } = await query(`
      SELECT
        m.id, m.order_id, m.sender_id, m.content, m.type,
        m.file_url, m.is_read, m.created_at,
        u.full_name AS sender_name, u.avatar_url AS sender_avatar,
        u.role AS sender_role
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.order_id = $1
      ORDER BY m.created_at ASC
      LIMIT 200
    `, [orderId]);

    // NO marcamos como leídos aquí — eso solo ocurre cuando el usuario
    // abre el chat explícitamente (PATCH /:orderId/read)
    res.json({ success: true, data: messages });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /messages/:orderId — Enviar mensaje ─────────────────
router.post('/:orderId', authenticate, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { content, type = 'text', fileUrl } = req.body;
    const userId = req.user.id;

    if (!content?.trim() && !fileUrl) {
      return res.status(400).json({ success: false, message: 'El mensaje no puede estar vacío' });
    }

    // Verificar acceso
    const { rows: [order] } = await query(
      "SELECT id, client_id, provider_id, status FROM orders WHERE id = $1",
      [orderId]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    if (order.client_id !== userId && order.provider_id !== userId) {
      return res.status(403).json({ success: false, message: 'Sin acceso a esta conversación' });
    }

    // Insertar mensaje
    const { rows: [message] } = await query(`
      INSERT INTO messages (order_id, sender_id, content, type, file_url)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [orderId, userId, content?.trim() || null, type, fileUrl || null]);

    // Obtener datos del remitente
    const { rows: [sender] } = await query(
      'SELECT full_name, avatar_url, role FROM users WHERE id = $1',
      [userId]
    );

    const fullMessage = {
      ...message,
      sender_name:   sender.full_name,
      sender_avatar: sender.avatar_url,
      sender_role:   sender.role,
    };

    // Emitir a la sala de la orden (el chat en tiempo real)
    emitToOrder(orderId, 'new_message', fullMessage);

    // Emitir notificación de badge a la sala personal del OTRO usuario
    // para que el badge se actualice en home/orders aunque no esté en el chat
    const recipientId = order.client_id === userId ? order.provider_id : order.client_id;
    const ioInstance  = getIO();
    if (recipientId && ioInstance) {
      ioInstance.to(`user:${recipientId}`).emit('new_message_notification', {
        orderId, fromUserId: userId, senderName: sender.full_name,
      });
    }

    res.status(201).json({ success: true, data: fullMessage });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /messages/:orderId/unread-count — Contar sin marcar leído
// Usado por badges en home/orders — NO modifica is_read
router.get('/:orderId/unread-count', authenticate, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.id;

    // Verificar acceso
    const { rows: [order] } = await query(
      'SELECT id, client_id, provider_id FROM orders WHERE id = $1',
      [orderId]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    if (order.client_id !== userId && order.provider_id !== userId) {
      return res.status(403).json({ success: false, message: 'Sin acceso' });
    }

    const { rows: [result] } = await query(
      'SELECT COUNT(*) AS count FROM messages WHERE order_id = $1 AND sender_id != $2 AND is_read = false',
      [orderId, userId]
    );

    res.json({ success: true, data: { count: parseInt(result.count) } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /messages/:orderId/read — Marcar como leídos ───────
router.patch('/:orderId/read', authenticate, async (req, res) => {
  try {
    await query(`
      UPDATE messages SET is_read = true
      WHERE order_id = $1 AND sender_id != $2 AND is_read = false
    `, [req.params.orderId, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;