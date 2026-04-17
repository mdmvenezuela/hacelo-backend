// ══════════════════════════════════════════════════════════════
// src/routes/order.routes.js — con notificaciones push
// ══════════════════════════════════════════════════════════════
const express = require('express');
const { authenticate, requireClient, requireProvider, requireAny } = require('../middlewares/auth.middleware');
const { query } = require('../config/db');
const { emitToUser } = require('../config/socket');
const push = require('../services/pushNotifications');

const router = express.Router();

// ── helpers ───────────────────────────────────────────────────
const getOrderFull = async (orderId) => {
  const { rows: [o] } = await query(`
    SELECT
      o.*,
      c.full_name  AS client_name,
      p.full_name  AS provider_name,
      cat.name     AS category_name,
      cat.icon     AS category_icon,
      COALESCE(json_agg(oi.*) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
    FROM orders o
    JOIN users c    ON c.id = o.client_id
    LEFT JOIN users p ON p.id = o.provider_id
    LEFT JOIN categories cat ON cat.id = o.category_id
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.id = $1
    GROUP BY o.id, c.full_name, p.full_name, cat.name, cat.icon
  `, [orderId]);
  return o;
};

// ── POST /orders — Crear orden ────────────────────────────────
router.post('/', authenticate, requireClient, async (req, res) => {
  try {
    const {
      providerId, categoryId, title, description,
      address, city = 'Cabimas', isUrgent = false, photos = [],
    } = req.body;

    if (!providerId || !title || !address) {
      return res.status(400).json({ success: false, message: 'providerId, title y address son requeridos' });
    }

    // Verificar proveedor activo
    const { rows: [prov] } = await query(
      `SELECT u.id, u.full_name, pp.visit_price, pp.is_verified
       FROM users u JOIN provider_profiles pp ON pp.user_id = u.id
       WHERE u.id = $1 AND u.is_active = true`,
      [providerId]
    );
    if (!prov) return res.status(404).json({ success: false, message: 'Proveedor no encontrado' });
    if (!prov.is_verified) return res.status(400).json({ success: false, message: 'Proveedor no verificado' });

    const visitPrice = parseFloat(prov.visit_price || 0);

    // Verificar saldo del cliente
    const { rows: [wallet] } = await query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [req.user.id]
    );
    if (!wallet || parseFloat(wallet.balance) < visitPrice) {
      return res.status(400).json({ success: false, message: 'Saldo insuficiente' });
    }

    // Bloquear monto de visita
    await query(
      'UPDATE wallets SET balance = balance - $1, blocked_balance = blocked_balance + $1 WHERE user_id = $2',
      [visitPrice, req.user.id]
    );

    // Obtener número de orden
    const { rows: [{ count }] } = await query('SELECT COUNT(*) FROM orders');
    const orderNumber = parseInt(count) + 1;

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

    const { rows: [order] } = await query(`
      INSERT INTO orders
        (client_id, provider_id, category_id, title, description,
         address, city, is_urgent, visit_price, photos,
         status, order_number, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'requested',$11,$12)
      RETURNING *
    `, [
      req.user.id, providerId, categoryId, title, description || null,
      address, city, isUrgent, visitPrice, JSON.stringify(photos),
      orderNumber, expiresAt,
    ]);

    const full = await getOrderFull(order.id);

    // Socket
    emitToUser(providerId, 'new_order', full);

    // 🔔 Push notification al proveedor
    await push.notifyNewOrder(providerId, {
      id: order.id,
      clientName: req.user.full_name,
      categoryName: full.category_name || 'servicio',
    });

    res.status(201).json({ success: true, data: full });
  } catch (err) {
    console.error('create order error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /orders — Listar órdenes del usuario ──────────────────
router.get('/', authenticate, requireAny, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const isProvider = req.user.role === 'provider';

    const conditions = [isProvider ? 'o.provider_id = $1' : 'o.client_id = $1'];
    const params = [req.user.id];

    if (status) {
      conditions.push(`o.status = $${params.length + 1}`);
      params.push(status);
    }

    const { rows } = await query(`
      SELECT
        o.id, o.order_number, o.title, o.status, o.visit_price,
        o.work_total, o.is_urgent, o.created_at, o.expires_at,
        c.full_name AS client_name,
        p.full_name AS provider_name,
        cat.name    AS category_name,
        cat.icon    AS category_icon
      FROM orders o
      JOIN users c ON c.id = o.client_id
      LEFT JOIN users p ON p.id = o.provider_id
      LEFT JOIN categories cat ON cat.id = o.category_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY o.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /orders/:id ───────────────────────────────────────────
router.get('/:id', authenticate, requireAny, async (req, res) => {
  try {
    const full = await getOrderFull(req.params.id);
    if (!full) return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    res.json({ success: true, data: full });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /orders/:id/accept — Proveedor acepta ────────────────
router.post('/:id/accept', authenticate, requireProvider, async (req, res) => {
  try {
    const { rows: [order] } = await query(
      "UPDATE orders SET status='accepted', accepted_at=NOW() WHERE id=$1 AND provider_id=$2 AND status='requested' RETURNING *",
      [req.params.id, req.user.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    const full = await getOrderFull(order.id);
    emitToUser(order.client_id, 'order_accepted', full);

    // 🔔 Push al cliente
    await push.notifyOrderAccepted(order.client_id, {
      id: order.id,
      providerName: req.user.full_name,
    });

    res.json({ success: true, data: full });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /orders/:id/reject — Proveedor rechaza ───────────────
router.post('/:id/reject', authenticate, requireProvider, async (req, res) => {
  try {
    const { reason } = req.body;
    const { rows: [order] } = await query(
      `UPDATE orders SET status='cancelled', cancelled_at=NOW(), cancel_reason=$1
       WHERE id=$2 AND provider_id=$3 AND status IN ('requested','accepted') RETURNING *`,
      [reason || 'Rechazado por el proveedor', req.params.id, req.user.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    // Devolver saldo bloqueado al cliente
    await query(
      'UPDATE wallets SET balance=balance+$1, blocked_balance=blocked_balance-$1 WHERE user_id=$2',
      [order.visit_price, order.client_id]
    );

    const full = await getOrderFull(order.id);
    emitToUser(order.client_id, 'order_rejected', full);

    // 🔔 Push al cliente
    await push.notifyOrderRejected(order.client_id, {
      id: order.id,
      providerName: req.user.full_name,
    });

    res.json({ success: true, data: full });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /orders/:id/on-the-way — Proveedor en camino ────────
router.post('/:id/on-the-way', authenticate, requireProvider, async (req, res) => {
  try {
    const { rows: [order] } = await query(
      "UPDATE orders SET status='on_the_way', on_the_way_at=NOW() WHERE id=$1 AND provider_id=$2 AND status='accepted' RETURNING *",
      [req.params.id, req.user.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Orden no válida' });

    const full = await getOrderFull(order.id);
    emitToUser(order.client_id, 'order_on_the_way', full);

    // 🔔 Push al cliente
    await push.notifyProviderOnTheWay(order.client_id, {
      id: order.id,
      providerName: req.user.full_name,
    });

    res.json({ success: true, data: full });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /orders/:id/arrived — Proveedor llegó (cobra visita) ─
router.post('/:id/arrived', authenticate, requireProvider, async (req, res) => {
  try {
    const { rows: [order] } = await query(
      "SELECT * FROM orders WHERE id=$1 AND provider_id=$2 AND status='on_the_way'",
      [req.params.id, req.user.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Orden no válida' });

    const commissionRate = 0.135;
    const visitPrice     = parseFloat(order.visit_price);
    const commission     = parseFloat((visitPrice * commissionRate).toFixed(2));
    const net            = parseFloat((visitPrice - commission).toFixed(2));

    // Cobrar visita: sacar del blocked del cliente, dar neto al proveedor
    await query(
      'UPDATE wallets SET blocked_balance=blocked_balance-$1 WHERE user_id=$2',
      [visitPrice, order.client_id]
    );
    await query(
      'UPDATE wallets SET balance=balance+$1, total_earned=total_earned+$1 WHERE user_id=$2',
      [net, order.provider_id]
    );

    const { rows: [updated] } = await query(
      `UPDATE orders SET status='diagnosing', diagnosing_at=NOW(),
       visit_paid=true, visit_charged_at=NOW(),
       commission_rate=$1, commission_amount=$2
       WHERE id=$3 RETURNING *`,
      [commissionRate, commission, order.id]
    );

    const full = await getOrderFull(updated.id);
    emitToUser(order.client_id, 'order_arrived', full);

    // 🔔 Push al cliente
    await push.notifyProviderArrived(order.client_id, {
      id: order.id,
      visitPrice: visitPrice.toFixed(2),
    });

    res.json({ success: true, data: full });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /orders/:id/items — Proveedor envía presupuesto ──────
router.post('/:id/items', authenticate, requireProvider, async (req, res) => {
  try {
    const { items } = req.body; // [{ name, description, quantity, unitPrice }]
    if (!items?.length) return res.status(400).json({ success: false, message: 'Items requeridos' });

    // Borrar items previos
    await query('DELETE FROM order_items WHERE order_id=$1', [req.params.id]);

    let workTotal = 0;
    for (const item of items) {
      const total = parseFloat((item.quantity * item.unitPrice).toFixed(2));
      workTotal += total;
      await query(
        `INSERT INTO order_items (order_id, name, description, quantity, unit_price, total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.params.id, item.name, item.description || null, item.quantity, item.unitPrice, total]
      );
    }

    const { rows: [order] } = await query(
      `UPDATE orders SET status='quote_sent', quote_sent_at=NOW(), work_total=$1
       WHERE id=$2 AND provider_id=$3 AND status='diagnosing' RETURNING *`,
      [workTotal.toFixed(2), req.params.id, req.user.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Orden no válida' });

    const full = await getOrderFull(order.id);
    emitToUser(order.client_id, 'order_quote_sent', full);

    // 🔔 Push al cliente
    await push.notifyQuoteSent(order.client_id, {
      id: order.id,
      providerName: req.user.full_name,
      workTotal: workTotal.toFixed(2),
    });

    res.json({ success: true, data: full });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /orders/:id/accept-quote — Cliente acepta presupuesto ─
router.post('/:id/accept-quote', authenticate, requireClient, async (req, res) => {
  try {
    const { rows: [order] } = await query(
      "SELECT * FROM orders WHERE id=$1 AND client_id=$2 AND status='quote_sent'",
      [req.params.id, req.user.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Orden no válida' });

    const workTotal = parseFloat(order.work_total);

    // Verificar saldo
    const { rows: [wallet] } = await query('SELECT balance FROM wallets WHERE user_id=$1', [req.user.id]);
    if (parseFloat(wallet.balance) < workTotal) {
      return res.status(400).json({ success: false, message: 'Saldo insuficiente' });
    }

    // Bloquear monto del trabajo
    await query(
      'UPDATE wallets SET balance=balance-$1, blocked_balance=blocked_balance+$1 WHERE user_id=$2',
      [workTotal, req.user.id]
    );

    const { rows: [updated] } = await query(
      "UPDATE orders SET status='in_progress', work_started_at=NOW() WHERE id=$1 RETURNING *",
      [order.id]
    );

    const full = await getOrderFull(updated.id);
    emitToUser(order.provider_id, 'order_quote_accepted', full);

    // 🔔 Push al proveedor
    await push.notifyQuoteAccepted(order.provider_id, {
      id: order.id,
      workTotal: workTotal.toFixed(2),
    });

    res.json({ success: true, data: full });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /orders/:id/complete — Proveedor marca completado ────
router.post('/:id/complete', authenticate, requireProvider, async (req, res) => {
  try {
    const confirmDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000);

    const { rows: [order] } = await query(
      `UPDATE orders SET status='completed', completed_at=NOW(), confirm_deadline=$1
       WHERE id=$2 AND provider_id=$3 AND status='in_progress' RETURNING *`,
      [confirmDeadline, req.params.id, req.user.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Orden no válida' });

    const full = await getOrderFull(order.id);
    emitToUser(order.client_id, 'order_completed', full);

    // 🔔 Push al cliente
    await push.notifyWorkCompleted(order.client_id, {
      id: order.id,
      providerName: req.user.full_name,
    });

    res.json({ success: true, data: full });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /orders/:id/confirm — Cliente confirma trabajo ───────
router.post('/:id/confirm', authenticate, requireClient, async (req, res) => {
  try {
    const { rating, review } = req.body;

    const { rows: [order] } = await query(
      "SELECT * FROM orders WHERE id=$1 AND client_id=$2 AND status='completed'",
      [req.params.id, req.user.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Orden no válida' });

    const workTotal      = parseFloat(order.work_total || 0);
    const commissionRate = parseFloat(order.commission_rate || 0.135);
    const commission     = parseFloat((workTotal * commissionRate).toFixed(2));
    const net            = parseFloat((workTotal - commission).toFixed(2));

    // Liberar pago al proveedor
    await query(
      'UPDATE wallets SET blocked_balance=blocked_balance-$1 WHERE user_id=$2',
      [workTotal, order.client_id]
    );
    await query(
      'UPDATE wallets SET balance=balance+$1, total_earned=total_earned+$1 WHERE user_id=$2',
      [net, order.provider_id]
    );

    // Actualizar stats del proveedor
    await query(
      `UPDATE provider_profiles SET
         orders_completed=orders_completed+1,
         points=points+1,
         rating_count=rating_count+CASE WHEN $1 IS NOT NULL THEN 1 ELSE 0 END,
         rating_sum=rating_sum+COALESCE($1,0),
         rating_avg=CASE WHEN rating_count+CASE WHEN $1 IS NOT NULL THEN 1 ELSE 0 END > 0
                    THEN (rating_sum+COALESCE($1,0))/(rating_count+CASE WHEN $1 IS NOT NULL THEN 1 ELSE 0 END)
                    ELSE 0 END,
         level=CASE WHEN points+1 > 200 THEN 'oro' WHEN points+1 > 50 THEN 'plata' ELSE 'lila' END
       WHERE user_id=$2`,
      [rating || null, order.provider_id]
    );

    // Guardar reseña
    const warrantyDays = 7;
    const warrantyExp  = new Date(Date.now() + warrantyDays * 24 * 60 * 60 * 1000);

    await query(
      `UPDATE orders SET
         status='confirmed', confirmed_at=NOW(),
         work_paid=true, work_paid_at=NOW(),
         commission_amount=$1,
         client_rating=$2, client_review=$3, client_rated_at=NOW(),
         warranty_days=$4, warranty_expires_at=$5
       WHERE id=$6`,
      [commission, rating || null, review || null, warrantyDays, warrantyExp, order.id]
    );

    const full = await getOrderFull(order.id);
    emitToUser(order.provider_id, 'order_confirmed', full);

    // 🔔 Push al proveedor
    await push.notifyPaymentReleased(order.provider_id, {
      id: order.id,
      netEarned: net.toFixed(2),
    });

    res.json({ success: true, data: full });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;