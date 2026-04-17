const express    = require('express');
const { query, transaction } = require('../config/db');
const { authenticate, requireProvider } = require('../middlewares/auth.middleware');
const WalletService = require('../services/wallet.service');
const { emitToUser } = require('../config/socket');
const push = require('../services/pushNotifications'); // 🔔 NUEVO

const router = express.Router();

// ── GET /orders ───────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const userId = req.user.id;
    const role   = req.user.role;
    const conditions = [role === 'provider' ? 'o.provider_id = $1' : 'o.client_id = $1'];
    const params = [userId];
    if (status) { params.push(status); conditions.push(`o.status = $${params.length}`); }
    const { rows } = await query(`
      SELECT o.*, uc.full_name AS client_name, uc.avatar_url AS client_avatar,
        up.full_name AS provider_name, up.avatar_url AS provider_avatar,
        c.name AS category_name, c.icon AS category_icon,
        pp.rating_avg AS provider_rating
      FROM orders o
      JOIN users uc ON uc.id = o.client_id
      LEFT JOIN users up ON up.id = o.provider_id
      LEFT JOIN categories c ON c.id = o.category_id
      LEFT JOIN provider_profiles pp ON pp.user_id = o.provider_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY CASE o.status
        WHEN 'requested' THEN 1 WHEN 'accepted' THEN 2 WHEN 'in_conversation' THEN 3
        WHEN 'on_the_way' THEN 4 WHEN 'diagnosing' THEN 5 WHEN 'quote_sent' THEN 6
        WHEN 'in_progress' THEN 7 WHEN 'completed' THEN 8 WHEN 'confirmed' THEN 9
        WHEN 'cancelled' THEN 10 ELSE 11 END, o.created_at DESC
      LIMIT $${params.length+1} OFFSET $${params.length+2}
    `, [...params, parseInt(limit), parseInt(offset)]);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /orders/:id ───────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows: [order] } = await query(`
      SELECT o.*, uc.full_name AS client_name, uc.avatar_url AS client_avatar,
        up.full_name AS provider_name, up.avatar_url AS provider_avatar,
        c.name AS category_name, c.icon AS category_icon,
        pp.rating_avg AS provider_rating
      FROM orders o
      JOIN users uc ON uc.id = o.client_id
      LEFT JOIN users up ON up.id = o.provider_id
      LEFT JOIN categories c ON c.id = o.category_id
      LEFT JOIN provider_profiles pp ON pp.user_id = o.provider_id
      WHERE o.id = $1
    `, [req.params.id]);
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    const { rows: items } = await query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY created_at', [req.params.id]);
    let photos = order.photos;
    if (!photos) photos = [];
    else if (typeof photos === 'string') { try { photos = JSON.parse(photos); } catch { photos = []; } }
    if (!Array.isArray(photos)) photos = [];
    res.json({ success: true, data: { ...order, photos, items } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /orders ──────────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    const { providerId, categoryId, title, description, address, city='Cabimas', isUrgent=false, photos=[] } = req.body;
    if (!providerId || !title || !address)
      return res.status(400).json({ success: false, message: 'providerId, title y address son requeridos' });
    const { rows: [pp] } = await query('SELECT id, visit_price, is_available FROM provider_profiles WHERE user_id=$1', [providerId]);
    if (!pp)              return res.status(404).json({ success: false, message: 'Proveedor no encontrado' });
    if (!pp.is_available) return res.status(400).json({ success: false, message: 'El proveedor no está disponible' });
    const visitPrice = parseFloat(pp.visit_price);
    await WalletService.blockFunds(req.user.id, visitPrice, { description: `Reserva de visita — ${title}` });
    const expiresAt  = new Date(Date.now() + 30*60*1000).toISOString();
    const photosJson = JSON.stringify(Array.isArray(photos) ? photos : []);
    const { rows: [order] } = await query(`
      INSERT INTO orders (client_id,provider_id,category_id,title,description,address,city,is_urgent,visit_price,status,expires_at,photos)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'requested',$10,$11::jsonb) RETURNING *
    `, [req.user.id, providerId, categoryId||null, title, description||null, address, city, isUrgent, visitPrice, expiresAt, photosJson]);
    emitToUser(providerId, 'new_order', { orderId:order.id, orderNumber:`#${String(order.order_number).padStart(6,'0')}`, message:`Nueva solicitud: ${title}`, isUrgent });
    // 🔔 Push al proveedor
    push.notifyNewOrder(providerId, { id: order.id, clientName: req.user.full_name, categoryName: title }).catch(() => {});
    res.status(201).json({ success: true, data: order });
  } catch (err) { console.error('create order:', err); res.status(500).json({ success: false, message: err.message }); }
});

// ── PATCH /orders/:id/accept ──────────────────────────────────
router.patch('/:id/accept', authenticate, requireProvider, async (req, res) => {
  try {
    const { rows:[order] } = await query("SELECT * FROM orders WHERE id=$1 AND provider_id=$2 AND status='requested'", [req.params.id, req.user.id]);
    if (!order) return res.status(404).json({ success:false, message:'Orden no encontrada o no puedes aceptarla' });
    await query("UPDATE orders SET status='accepted', accepted_at=NOW() WHERE id=$1", [order.id]);
    emitToUser(order.client_id, 'order_accepted', { orderId:order.id, message:'El proveedor aceptó tu solicitud.' });
    // 🔔 Push al cliente
    push.notifyOrderAccepted(order.client_id, { id: order.id, providerName: req.user.full_name }).catch(() => {});
    res.json({ success:true });
  } catch (err) { res.status(500).json({ success:false, message:err.message }); }
});

// ── PATCH /orders/:id/reject — Proveedor rechaza (status=requested)
router.patch('/:id/reject', authenticate, requireProvider, async (req, res) => {
  try {
    const { reason='Sin razón indicada' } = req.body;
    const { rows:[order] } = await query("SELECT * FROM orders WHERE id=$1 AND provider_id=$2 AND status='requested'", [req.params.id, req.user.id]);
    if (!order) return res.status(404).json({ success:false, message:'Orden no encontrada o no puedes rechazarla' });
    await transaction(async (client) => {
      await client.query("UPDATE orders SET status='cancelled', cancel_reason=$1, cancelled_at=NOW() WHERE id=$2", [reason, order.id]);
      const { rows:[cw] } = await client.query('SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE', [order.client_id]);
      const newBal = parseFloat(cw.balance) + parseFloat(order.visit_price);
      const newBlk = Math.max(0, parseFloat(cw.blocked_balance) - parseFloat(order.visit_price));
      await client.query('UPDATE wallets SET balance=$1, blocked_balance=$2 WHERE user_id=$3', [newBal, newBlk, order.client_id]);
      await client.query(`INSERT INTO wallet_transactions (wallet_id,type,status,amount,balance_before,balance_after,reference_id,reference_type,description) VALUES ($1,'visit_unblock','approved',$2,$3,$4,$5,'order',$6)`,
        [cw.id, order.visit_price, parseFloat(cw.balance), newBal, order.id, `Proveedor rechazó solicitud — Orden #${String(order.order_number).padStart(6,'0')}`]);
    });
    emitToUser(order.client_id, 'order_rejected', { orderId:order.id, message:`El proveedor rechazó tu solicitud. Tu saldo fue devuelto. Razón: ${reason}` });
    // 🔔 Push al cliente
    push.notifyOrderRejected(order.client_id, { id: order.id, providerName: req.user.full_name }).catch(() => {});
    res.json({ success:true });
  } catch (err) { res.status(500).json({ success:false, message:err.message }); }
});

// ── PATCH /orders/:id/reject-quote — Cliente rechaza presupuesto (status=quote_sent)
router.patch('/:id/reject-quote', authenticate, async (req, res) => {
  try {
    const { reason='Presupuesto rechazado por el cliente' } = req.body;
    const { rows:[order] } = await query("SELECT * FROM orders WHERE id=$1 AND client_id=$2 AND status='quote_sent'", [req.params.id, req.user.id]);
    if (!order) return res.status(404).json({ success:false, message:'Orden no encontrada o no está en estado de presupuesto' });
    await query("UPDATE orders SET status='cancelled', cancel_reason=$1, cancelled_at=NOW() WHERE id=$2", [reason, order.id]);
    emitToUser(order.provider_id, 'quote_rejected', { orderId:order.id, message:'El cliente rechazó el presupuesto.' });
    // 🔔 Push al proveedor
    push.notifyQuoteRejected(order.provider_id, { id: order.id }).catch(() => {});
    res.json({ success:true, message:'Presupuesto rechazado' });
  } catch (err) { res.status(500).json({ success:false, message:err.message }); }
});

// ── PATCH /orders/:id/on-the-way ─────────────────────────────
router.patch('/:id/on-the-way', authenticate, requireProvider, async (req, res) => {
  try {
    const { rows:[order] } = await query("SELECT * FROM orders WHERE id=$1 AND provider_id=$2 AND status IN ('accepted','in_conversation')", [req.params.id, req.user.id]);
    if (!order) return res.status(404).json({ success:false, message:'Orden no encontrada' });
    await query("UPDATE orders SET status='on_the_way', on_the_way_at=NOW() WHERE id=$1", [order.id]);
    emitToUser(order.client_id, 'provider_on_the_way', { orderId:order.id, message:'El técnico está en camino.' });
    // 🔔 Push al cliente
    push.notifyProviderOnTheWay(order.client_id, { id: order.id, providerName: req.user.full_name }).catch(() => {});
    res.json({ success:true });
  } catch (err) { res.status(500).json({ success:false, message:err.message }); }
});

// ── PATCH /orders/:id/schedule-visit ─────────────────────────
router.patch('/:id/schedule-visit', authenticate, requireProvider, async (req, res) => {
  try {
    const { scheduledAt } = req.body;
    if (!scheduledAt) return res.status(400).json({ success:false, message:'scheduledAt es requerido' });
    const { rows:[order] } = await query("SELECT * FROM orders WHERE id=$1 AND provider_id=$2 AND status IN ('accepted','in_conversation')", [req.params.id, req.user.id]);
    if (!order) return res.status(404).json({ success:false, message:'Orden no encontrada' });
    await query("UPDATE orders SET scheduled_at=$1, status='in_conversation' WHERE id=$2", [scheduledAt, order.id]);
    const fechaFormateada = new Date(scheduledAt).toLocaleDateString('es-VE',{weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'});
    emitToUser(order.client_id, 'visit_scheduled', {
      orderId:order.id, scheduledAt,
      message:`El técnico programó la visita para el ${fechaFormateada}.`,
    });
    // 🔔 Push al cliente
    push.sendPushToUser(order.client_id, {
      title: '📅 Visita programada',
      body: `El técnico programó la visita para el ${fechaFormateada}`,
      data: { screen: 'order', orderId: order.id },
    }).catch(() => {});
    res.json({ success:true });
  } catch (err) { res.status(500).json({ success:false, message:err.message }); }
});

// ── PATCH /orders/:id/arrived ─────────────────────────────────
router.patch('/:id/arrived', authenticate, requireProvider, async (req, res) => {
  try {
    const { rows:[order] } = await query("SELECT * FROM orders WHERE id=$1 AND provider_id=$2 AND status='on_the_way'", [req.params.id, req.user.id]);
    if (!order) return res.status(404).json({ success:false, message:'Orden no encontrada' });
    await WalletService.chargeVisit(order.client_id, order.provider_id, order.visit_price, order.id);
    await query("UPDATE orders SET status='diagnosing', arrived_at=NOW() WHERE id=$1", [order.id]);
    emitToUser(order.client_id, 'provider_arrived', { orderId:order.id, message:`El técnico llegó. Se cobró $${order.visit_price} por la visita.` });
    // 🔔 Push al cliente
    push.notifyProviderArrived(order.client_id, { id: order.id, visitPrice: parseFloat(order.visit_price).toFixed(2) }).catch(() => {});
    res.json({ success:true });
  } catch (err) { res.status(500).json({ success:false, message:err.message }); }
});

// ── POST /orders/:id/items ────────────────────────────────────
router.post('/:id/items', authenticate, requireProvider, async (req, res) => {
  try {
    const { items } = req.body;
    if (!items?.length) return res.status(400).json({ success:false, message:'Se requiere al menos un ítem' });
    const { rows:[order] } = await query("SELECT * FROM orders WHERE id=$1 AND provider_id=$2 AND status IN ('diagnosing','quote_sent')", [req.params.id, req.user.id]);
    if (!order) return res.status(404).json({ success:false, message:'Orden no encontrada' });
    await transaction(async (client) => {
      await client.query('DELETE FROM order_items WHERE order_id=$1', [order.id]);
      let workTotal = 0;
      for (const item of items) {
        const total = parseFloat(item.unitPrice) * parseFloat(item.quantity||1);
        workTotal  += total;
        await client.query('INSERT INTO order_items (order_id,name,description,quantity,unit_price,total) VALUES ($1,$2,$3,$4,$5,$6)',
          [order.id, item.name, item.description||null, item.quantity||1, item.unitPrice, total]);
      }
      await client.query("UPDATE orders SET status='quote_sent', work_total=$1, quote_sent_at=NOW() WHERE id=$2", [workTotal.toFixed(2), order.id]);
    });
    const { rows:[upd] } = await query('SELECT work_total FROM orders WHERE id=$1', [order.id]);
    emitToUser(order.client_id, 'quote_received', { orderId:order.id, message:`El técnico envió un presupuesto de $${parseFloat(upd.work_total).toFixed(2)}.` });
    // 🔔 Push al cliente
    push.notifyQuoteSent(order.client_id, { id: order.id, providerName: req.user.full_name, workTotal: parseFloat(upd.work_total).toFixed(2) }).catch(() => {});
    res.json({ success:true });
  } catch (err) { res.status(500).json({ success:false, message:err.message }); }
});

// ── PATCH /orders/:id/accept-quote ───────────────────────────
router.patch('/:id/accept-quote', authenticate, async (req, res) => {
  try {
    const { rows:[order] } = await query("SELECT * FROM orders WHERE id=$1 AND client_id=$2 AND status='quote_sent'", [req.params.id, req.user.id]);
    if (!order) return res.status(404).json({ success:false, message:'Orden no encontrada' });
    await WalletService.blockFunds(req.user.id, order.work_total, {
      orderId:order.id, description:`Pago por trabajo — Orden #${String(order.order_number).padStart(6,'0')}`
    });
    await query("UPDATE orders SET status='in_progress', work_accepted_at=NOW() WHERE id=$1", [order.id]);
    emitToUser(order.provider_id, 'quote_accepted', { orderId:order.id, message:'¡El cliente aceptó el presupuesto! Comienza el trabajo.' });
    // 🔔 Push al proveedor
    push.notifyQuoteAccepted(order.provider_id, { id: order.id, workTotal: parseFloat(order.work_total).toFixed(2) }).catch(() => {});
    res.json({ success:true });
  } catch (err) { res.status(500).json({ success:false, message:err.message }); }
});

// ── PATCH /orders/:id/complete ────────────────────────────────
router.patch('/:id/complete', authenticate, requireProvider, async (req, res) => {
  try {
    const { rows:[order] } = await query("SELECT * FROM orders WHERE id=$1 AND provider_id=$2 AND status='in_progress'", [req.params.id, req.user.id]);
    if (!order) return res.status(404).json({ success:false, message:'Orden no encontrada' });
    const confirmDeadline = new Date(Date.now() + 48*60*60*1000).toISOString();
    await query("UPDATE orders SET status='completed', completed_at=NOW(), confirm_deadline=$1 WHERE id=$2", [confirmDeadline, order.id]);
    // ── Registrar en escrow del proveedor (blocked_balance) ─
    await query('UPDATE wallets SET blocked_balance = blocked_balance + $1 WHERE user_id = $2', [order.work_total, order.provider_id]);
    emitToUser(order.client_id, 'order_completed', {
      orderId:order.id, confirmDeadline,
      message:'El técnico marcó el trabajo como terminado. Tienes 48 horas para confirmar.',
    });
    // 🔔 Push al cliente
    push.notifyWorkCompleted(order.client_id, { id: order.id, providerName: req.user.full_name }).catch(() => {});
    res.json({ success:true });
  } catch (err) { res.status(500).json({ success:false, message:err.message }); }
});

// ── PATCH /orders/:id/confirm ─────────────────────────────────
router.patch('/:id/confirm', authenticate, async (req, res) => {
  try {
    const { rating, review } = req.body;
    const { rows:[order] } = await query("SELECT * FROM orders WHERE id=$1 AND client_id=$2 AND status='completed'", [req.params.id, req.user.id]);
    if (!order) return res.status(404).json({ success:false, message:'Orden no encontrada' });
    await WalletService.releaseWorkPayment(order.client_id, order.provider_id, order.work_total, order.id);
    await query('UPDATE wallets SET blocked_balance = GREATEST(0, blocked_balance - $1) WHERE user_id = $2', [order.work_total, order.provider_id]);
    const now = new Date().toISOString();
    await query("UPDATE orders SET status='confirmed', confirmed_at=$1, client_rating=$2, client_review=$3, client_rated_at=$4 WHERE id=$5",
      [now, rating||null, review||null, rating ? now : null, order.id]);
    await query(`
      UPDATE provider_profiles SET
        orders_completed = orders_completed + 1,
        points           = points + 1,
        rating_avg       = (SELECT COALESCE(AVG(client_rating),0) FROM orders WHERE provider_id=$1 AND client_rating IS NOT NULL),
        rating_count     = (SELECT COUNT(*) FROM orders WHERE provider_id=$1 AND client_rating IS NOT NULL),
        level = CASE WHEN points+1>200 THEN 'oro'::provider_level WHEN points+1>50 THEN 'plata'::provider_level ELSE 'lila'::provider_level END
      WHERE user_id=$1
    `, [order.provider_id]);
    emitToUser(order.provider_id, 'order_confirmed', { orderId:order.id, message:'¡El cliente confirmó el trabajo! El pago fue liberado.', rating });
    // 🔔 Push al proveedor
    const rate = parseFloat(order.commission_rate || 0.135);
    const net  = parseFloat((parseFloat(order.work_total) * (1 - rate)).toFixed(2));
    push.notifyPaymentReleased(order.provider_id, { id: order.id, netEarned: net.toFixed(2) }).catch(() => {});
    res.json({ success:true });
  } catch (err) { res.status(500).json({ success:false, message:err.message }); }
});

module.exports = router;