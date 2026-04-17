// ══════════════════════════════════════════════════════════════
// HACELO — OrderController
// Maneja todo el ciclo de vida de una orden
// ══════════════════════════════════════════════════════════════

const { query, transaction } = require('../../config/db');
const WalletService = require('../../services/wallet.service');
const { emitToUser, emitToOrder } = require('../../config/socket');

// ── Calcular días de garantía según categoría ──────────────
const WARRANTY_DAYS = {
  'plomeria': 7, 'electricidad': 7, 'ac-refrigeracion': 7,
  'linea-blanca': 15, 'electronica': 15,
  'pintura': 3, 'albanileria': 3, 'carpinteria': 3,
  'limpieza': 1, 'jardineria': 1,
};

const getWarrantyDays = (categorySlug) => WARRANTY_DAYS[categorySlug] || 0;

// ── Formatear número de orden ──────────────────────────────
const formatOrderNumber = (n) => `#${String(n).padStart(6, '0')}`;

// ══════════════════════════════════════════════════════════════
// POST /orders — Cliente crea una orden
// ══════════════════════════════════════════════════════════════
const createOrder = async (req, res) => {
  try {
    const clientId = req.user.id;
    const {
      providerId, categoryId, title, description,
      photos = [], address, city = 'Cabimas',
      latitude, longitude, isUrgent = false, scheduledAt,
    } = req.body;

    // 1. Verificar que el proveedor existe y está activo
    const { rows: [provider] } = await query(`
      SELECT pp.*, u.full_name, u.is_active
      FROM provider_profiles pp
      JOIN users u ON u.id = pp.user_id
      WHERE pp.user_id = $1 AND u.is_active = true AND pp.is_available = true
    `, [providerId]);

    if (!provider) {
      return res.status(404).json({ success: false, message: 'Proveedor no disponible' });
    }

    // 2. Verificar saldo del cliente
    const clientWallet = await WalletService.getWallet(clientId);
    if (parseFloat(clientWallet.balance) < parseFloat(provider.visit_price)) {
      return res.status(400).json({
        success: false,
        message: 'Saldo insuficiente para cubrir el precio de la visita',
        code: 'INSUFFICIENT_BALANCE',
        data: {
          required: provider.visit_price,
          available: clientWallet.balance,
          missing: (parseFloat(provider.visit_price) - parseFloat(clientWallet.balance)).toFixed(2),
        },
      });
    }

    // 3. Obtener comisión del proveedor
    const rates = {
      lila: parseFloat(process.env.COMMISSION_LILA || 0.135),
      plata: parseFloat(process.env.COMMISSION_PLATA || 0.12),
      oro: parseFloat(process.env.COMMISSION_ORO || 0.10),
    };
    const commissionRate = rates[provider.level || 'lila'];

    // 4. Timeout para aceptación
    const timeoutMinutes = parseInt(process.env.ORDER_ACCEPT_TIMEOUT_MINUTES || 30);
    const expiresAt = new Date(Date.now() + timeoutMinutes * 60 * 1000);

    // 5. Crear orden y bloquear saldo en una transacción
    const order = await transaction(async (client) => {
      const { rows: [newOrder] } = await client.query(`
        INSERT INTO orders (
          client_id, provider_id, category_id, title, description, photos,
          address, city, latitude, longitude, is_urgent, scheduled_at,
          visit_price, commission_rate, status, expires_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'requested',$15)
        RETURNING *
      `, [
        clientId, providerId, categoryId, title, description,
        photos, address, city, latitude, longitude,
        isUrgent, scheduledAt, provider.visit_price, commissionRate, expiresAt,
      ]);

      // Bloquear saldo de la visita
      await client.query(
        'UPDATE wallets SET balance = balance - $1, blocked_balance = blocked_balance + $1 WHERE user_id = $2',
        [provider.visit_price, clientId]
      );

      // Log de la transacción
      const { rows: [wallet] } = await client.query('SELECT * FROM wallets WHERE user_id = $1', [clientId]);
      await WalletService.logTransaction(client, {
        walletId: wallet.id, type: 'visit_block', status: 'approved',
        amount: provider.visit_price,
        balanceBefore: parseFloat(wallet.balance) + parseFloat(provider.visit_price),
        balanceAfter: parseFloat(wallet.balance),
        referenceId: newOrder.id, referenceType: 'order',
        description: `Bloqueo visita - Orden ${formatOrderNumber(newOrder.order_number)}`,
      });

      return newOrder;
    });

    // 6. Notificar al proveedor
    emitToUser(providerId, 'new_order', {
      orderId: order.id,
      orderNumber: formatOrderNumber(order.order_number),
      title: order.title,
      address: order.address,
      isUrgent: order.is_urgent,
      visitPrice: order.visit_price,
    });

    res.status(201).json({
      success: true,
      message: 'Orden creada exitosamente',
      data: {
        ...order,
        orderNumber: formatOrderNumber(order.order_number),
        visitPriceBlocked: provider.visit_price,
      },
    });

  } catch (err) {
    console.error('createOrder error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
// PATCH /orders/:id/accept — Proveedor acepta la orden
// ══════════════════════════════════════════════════════════════
const acceptOrder = async (req, res) => {
  try {
    const providerId = req.user.id;
    const { id: orderId } = req.params;

    const { rows: [order] } = await query(
      'SELECT * FROM orders WHERE id = $1 AND provider_id = $2',
      [orderId, providerId]
    );

    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    if (order.status !== 'requested') {
      return res.status(400).json({ success: false, message: `No se puede aceptar una orden en estado: ${order.status}` });
    }
    if (order.expires_at && new Date() > new Date(order.expires_at)) {
      return res.status(400).json({ success: false, message: 'Esta orden ha expirado' });
    }

    await query(
      `UPDATE orders SET status = 'accepted', accepted_at = NOW() WHERE id = $1`,
      [orderId]
    );

    // Notificar al cliente
    emitToUser(order.client_id, 'order_accepted', {
      orderId, orderNumber: formatOrderNumber(order.order_number),
      message: 'El proveedor aceptó tu solicitud. Ya puedes chatear con él.',
    });

    // Mensaje automático del sistema en el chat
    await query(`
      INSERT INTO messages (order_id, sender_id, content, is_system)
      VALUES ($1, $2, '✅ El proveedor aceptó la solicitud. El chat está habilitado.', true)
    `, [orderId, providerId]);

    res.json({ success: true, message: 'Orden aceptada', data: { status: 'accepted' } });

  } catch (err) {
    console.error('acceptOrder error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
// PATCH /orders/:id/reject — Proveedor rechaza la orden
// ══════════════════════════════════════════════════════════════
const rejectOrder = async (req, res) => {
  try {
    const providerId = req.user.id;
    const { id: orderId } = req.params;
    const { reason } = req.body;

    const { rows: [order] } = await query(
      `SELECT * FROM orders WHERE id = $1 AND provider_id = $2 AND status = 'requested'`,
      [orderId, providerId]
    );

    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    await transaction(async (client) => {
      // Actualizar orden
      await client.query(
        `UPDATE orders SET status = 'cancelled', cancelled_at = NOW(),
         cancelled_by = $1, cancel_reason = $2 WHERE id = $3`,
        [providerId, reason || 'Rechazada por el proveedor', orderId]
      );

      // Desbloquear saldo del cliente
      await client.query(
        'UPDATE wallets SET balance = balance + $1, blocked_balance = blocked_balance - $1 WHERE user_id = $2',
        [order.visit_price, order.client_id]
      );

      const { rows: [wallet] } = await client.query('SELECT * FROM wallets WHERE user_id = $1', [order.client_id]);
      await WalletService.logTransaction(client, {
        walletId: wallet.id, type: 'visit_unblock', status: 'approved',
        amount: order.visit_price,
        balanceBefore: parseFloat(wallet.balance) - parseFloat(order.visit_price),
        balanceAfter: parseFloat(wallet.balance),
        referenceId: orderId, referenceType: 'order',
        description: `Desbloqueo - Proveedor rechazó Orden ${formatOrderNumber(order.order_number)}`,
      });

      // Penalizar cancelaciones del proveedor
      await client.query(
        `UPDATE provider_profiles
         SET cancel_count = cancel_count + 1
         WHERE user_id = $1`,
        [providerId]
      );
    });

    // Notificar al cliente
    emitToUser(order.client_id, 'order_rejected', {
      orderId, orderNumber: formatOrderNumber(order.order_number),
      message: 'El proveedor rechazó tu solicitud. Tu saldo fue desbloqueado.',
      refundAmount: order.visit_price,
    });

    res.json({ success: true, message: 'Orden rechazada, saldo desbloqueado al cliente' });

  } catch (err) {
    console.error('rejectOrder error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
// PATCH /orders/:id/on-the-way — Proveedor va en camino
// ══════════════════════════════════════════════════════════════
const markOnTheWay = async (req, res) => {
  try {
    const providerId = req.user.id;
    const { id: orderId } = req.params;

    const { rows: [order] } = await query(
      `SELECT * FROM orders WHERE id = $1 AND provider_id = $2
       AND status IN ('accepted', 'in_conversation')`,
      [orderId, providerId]
    );

    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    await query(
      `UPDATE orders SET status = 'on_the_way', on_the_way_at = NOW() WHERE id = $1`,
      [orderId]
    );

    emitToUser(order.client_id, 'provider_on_the_way', {
      orderId, orderNumber: formatOrderNumber(order.order_number),
      message: '🚗 El técnico está en camino hacia tu ubicación.',
    });

    await query(`
      INSERT INTO messages (order_id, sender_id, content, is_system)
      VALUES ($1, $2, '🚗 El técnico está en camino.', true)
    `, [orderId, providerId]);

    res.json({ success: true, message: 'En camino', data: { status: 'on_the_way' } });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
// PATCH /orders/:id/arrived — Proveedor llegó → cobra la visita
// ══════════════════════════════════════════════════════════════
const markArrived = async (req, res) => {
  try {
    const providerId = req.user.id;
    const { id: orderId } = req.params;

    const { rows: [order] } = await query(
      `SELECT * FROM orders WHERE id = $1 AND provider_id = $2 AND status = 'on_the_way'`,
      [orderId, providerId]
    );

    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    // Cobrar la visita
    const { netAmount, commission } = await WalletService.chargeVisit(
      order.client_id, providerId, order.visit_price, orderId
    );

    await query(
      `UPDATE orders SET status = 'diagnosing', arrived_at = NOW() WHERE id = $1`,
      [orderId]
    );

    emitToUser(order.client_id, 'provider_arrived', {
      orderId, orderNumber: formatOrderNumber(order.order_number),
      message: `🔍 El técnico llegó. Se descontaron $${order.visit_price} de tu wallet por la visita.`,
      visitCharged: order.visit_price,
    });

    await query(`
      INSERT INTO messages (order_id, sender_id, content, is_system)
      VALUES ($1, $2, $3, true)
    `, [orderId, providerId,
        `🔍 El técnico llegó. Visita cobrada: $${order.visit_price}. En diagnóstico.`]);

    res.json({
      success: true,
      message: 'Llegada registrada, visita cobrada',
      data: { status: 'diagnosing', visitCharged: order.visit_price, netEarned: netAmount, commission },
    });

  } catch (err) {
    console.error('markArrived error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
// POST /orders/:id/items — Proveedor agrega ítems al presupuesto
// ══════════════════════════════════════════════════════════════
const addOrderItems = async (req, res) => {
  try {
    const providerId = req.user.id;
    const { id: orderId } = req.params;
    const { items } = req.body; // [{ name, description, quantity, unitPrice }]

    if (!items?.length) {
      return res.status(400).json({ success: false, message: 'Debes agregar al menos un ítem' });
    }

    const { rows: [order] } = await query(
      `SELECT * FROM orders WHERE id = $1 AND provider_id = $2 AND status = 'diagnosing'`,
      [orderId, providerId]
    );

    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    await transaction(async (client) => {
      // Eliminar ítems previos si los hay (puede re-enviar)
      await client.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);

      // Insertar nuevos ítems
      for (let i = 0; i < items.length; i++) {
        const { name, description = null, quantity = 1, unitPrice } = items[i];
        await client.query(`
          INSERT INTO order_items (order_id, name, description, quantity, unit_price, sort_order)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [orderId, name, description, quantity, unitPrice, i]);
      }

      // Actualizar estado (el trigger recalcula work_total automáticamente)
      await client.query(
        `UPDATE orders SET status = 'quote_sent', quote_sent_at = NOW() WHERE id = $1`,
        [orderId]
      );
    });

    // Obtener total calculado
    const { rows: [updatedOrder] } = await query(
      'SELECT work_total FROM orders WHERE id = $1', [orderId]
    );

    // Notificar al cliente
    emitToUser(order.client_id, 'quote_received', {
      orderId, orderNumber: formatOrderNumber(order.order_number),
      workTotal: updatedOrder.work_total,
      message: `📋 Recibiste un presupuesto de $${updatedOrder.work_total}. Revísalo en la app.`,
    });

    res.json({
      success: true,
      message: 'Presupuesto enviado al cliente',
      data: { workTotal: updatedOrder.work_total, itemsCount: items.length },
    });

  } catch (err) {
    console.error('addOrderItems error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
// PATCH /orders/:id/accept-quote — Cliente acepta y paga el trabajo
// ══════════════════════════════════════════════════════════════
const acceptQuote = async (req, res) => {
  try {
    const clientId = req.user.id;
    const { id: orderId } = req.params;

    const { rows: [order] } = await query(`
      SELECT o.*, c.slug as category_slug
      FROM orders o
      JOIN categories c ON c.id = o.category_id
      WHERE o.id = $1 AND o.client_id = $2 AND o.status = 'quote_sent'
    `, [orderId, clientId]);

    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    const workTotal = parseFloat(order.work_total);
    const wallet    = await WalletService.getWallet(clientId);
    const available = parseFloat(wallet.balance);

    if (available < workTotal) {
      return res.status(400).json({
        success: false,
        message: 'Saldo insuficiente para pagar el presupuesto',
        code: 'INSUFFICIENT_BALANCE',
        data: {
          required: workTotal,
          available,
          missing: (workTotal - available).toFixed(2),
        },
      });
    }

    // Calcular garantía
    const warrantyDays = getWarrantyDays(order.category_slug);
    const warrantyExp  = warrantyDays > 0
      ? new Date(Date.now() + warrantyDays * 24 * 60 * 60 * 1000)
      : null;

    const confirmDeadline = new Date(
      Date.now() + parseInt(process.env.ORDER_CONFIRM_TIMEOUT_HOURS || 48) * 3600 * 1000
    );

    await transaction(async (client) => {
      // Bloquear el monto del trabajo
      await client.query(
        'UPDATE wallets SET balance = balance - $1, blocked_balance = blocked_balance + $1 WHERE user_id = $2',
        [workTotal, clientId]
      );

      const { rows: [w] } = await client.query('SELECT * FROM wallets WHERE user_id = $1', [clientId]);
      await WalletService.logTransaction(client, {
        walletId: w.id, type: 'work_block', status: 'approved',
        amount: workTotal,
        balanceBefore: parseFloat(w.balance) + workTotal,
        balanceAfter: parseFloat(w.balance),
        referenceId: orderId, referenceType: 'order',
        description: `Pago bloqueado - Orden ${formatOrderNumber(order.order_number)}`,
      });

      await client.query(
        `UPDATE orders SET status = 'in_progress', work_started_at = NOW(),
         warranty_days = $1, warranty_expires_at = $2, confirm_deadline = $3
         WHERE id = $4`,
        [warrantyDays, warrantyExp, confirmDeadline, orderId]
      );
    });

    // Notificar al proveedor
    emitToUser(order.provider_id, 'payment_confirmed', {
      orderId, orderNumber: formatOrderNumber(order.order_number),
      message: `💳 El cliente pagó $${workTotal}. Puedes proceder con el trabajo.`,
      workTotal,
    });

    await query(`
      INSERT INTO messages (order_id, sender_id, content, is_system)
      VALUES ($1, $2, $3, true)
    `, [orderId, clientId,
        `⚡ Pago confirmado: $${workTotal}. El técnico puede proceder. Garantía: ${warrantyDays} días.`]);

    res.json({
      success: true,
      message: 'Pago confirmado, el técnico puede proceder',
      data: { status: 'in_progress', workTotal, warrantyDays },
    });

  } catch (err) {
    console.error('acceptQuote error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
// PATCH /orders/:id/complete — Proveedor marca trabajo terminado
// ══════════════════════════════════════════════════════════════
const markCompleted = async (req, res) => {
  try {
    const providerId = req.user.id;
    const { id: orderId } = req.params;

    const { rows: [order] } = await query(
      `SELECT * FROM orders WHERE id = $1 AND provider_id = $2 AND status = 'in_progress'`,
      [orderId, providerId]
    );

    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    await query(
      `UPDATE orders SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [orderId]
    );

    // El cliente tiene 48h para confirmar
    emitToUser(order.client_id, 'work_completed', {
      orderId, orderNumber: formatOrderNumber(order.order_number),
      message: '✅ El técnico marcó el trabajo como terminado. ¿Todo quedó bien?',
      confirmDeadline: order.confirm_deadline,
    });

    res.json({ success: true, message: 'Trabajo marcado como completado', data: { status: 'completed' } });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
// PATCH /orders/:id/confirm — Cliente confirma satisfacción → libera pago
// ══════════════════════════════════════════════════════════════
const confirmOrder = async (req, res) => {
  try {
    const clientId = req.user.id;
    const { id: orderId } = req.params;
    const { rating, review } = req.body;

    const { rows: [order] } = await query(
      `SELECT * FROM orders WHERE id = $1 AND client_id = $2 AND status = 'completed'`,
      [orderId, clientId]
    );

    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    // Liberar pago al proveedor
    const { netAmount } = await WalletService.releaseWorkPayment(
      clientId, order.provider_id, order.work_total, orderId
    );

    await query(
      `UPDATE orders
       SET status = 'confirmed', confirmed_at = NOW(),
           client_rating = $1, client_review = $2, client_rated_at = NOW()
       WHERE id = $3`,
      [rating || null, review || null, orderId]
    );

    emitToUser(order.provider_id, 'order_confirmed', {
      orderId, orderNumber: formatOrderNumber(order.order_number),
      message: `🎉 El cliente confirmó el trabajo. Recibiste $${netAmount} en tu wallet.`,
      netEarned: netAmount,
    });

    res.json({
      success: true,
      message: '¡Orden completada exitosamente!',
      data: { status: 'confirmed', providerEarned: netAmount },
    });

  } catch (err) {
    console.error('confirmOrder error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
// GET /orders/:id — Obtener detalle de una orden
// ══════════════════════════════════════════════════════════════
const getOrder = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id: orderId } = req.params;

    const { rows: [order] } = await query(`
      SELECT
        o.*,
        c.name as category_name, c.icon as category_icon,
        cl.full_name as client_name, cl.avatar_url as client_avatar,
        pr.full_name as provider_name, pr.avatar_url as provider_avatar,
        pp.rating_avg as provider_rating, pp.visit_price,
        pp.level as provider_level
      FROM orders o
      JOIN categories c ON c.id = o.category_id
      JOIN users cl ON cl.id = o.client_id
      LEFT JOIN users pr ON pr.id = o.provider_id
      LEFT JOIN provider_profiles pp ON pp.user_id = o.provider_id
      WHERE o.id = $1
        AND (o.client_id = $2 OR o.provider_id = $2)
    `, [orderId, userId]);

    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    // Obtener ítems
    const { rows: items } = await query(
      'SELECT * FROM order_items WHERE order_id = $1 ORDER BY sort_order',
      [orderId]
    );

    res.json({
      success: true,
      data: {
        ...order,
        orderNumber: formatOrderNumber(order.order_number),
        items,
      },
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════
// GET /orders — Listar órdenes del usuario
// ══════════════════════════════════════════════════════════════
const listOrders = async (req, res) => {
  try {
    const userId = req.user.id;
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let whereClause = '(o.client_id = $1 OR o.provider_id = $1)';
    const params = [userId];

    if (status) {
      params.push(status);
      whereClause += ` AND o.status = $${params.length}`;
    }

    const { rows: orders } = await query(`
      SELECT
        o.id, o.order_number, o.title, o.status, o.visit_price,
        o.work_total, o.is_urgent, o.created_at, o.address,
        c.name as category_name, c.icon as category_icon,
        cl.full_name as client_name,
        pr.full_name as provider_name, pr.avatar_url as provider_avatar
      FROM orders o
      JOIN categories c ON c.id = o.category_id
      JOIN users cl ON cl.id = o.client_id
      LEFT JOIN users pr ON pr.id = o.provider_id
      WHERE ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, parseInt(limit), offset]);

    res.json({
      success: true,
      data: orders.map(o => ({
        ...o,
        orderNumber: formatOrderNumber(o.order_number),
      })),
      pagination: { page: parseInt(page), limit: parseInt(limit) },
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  createOrder, acceptOrder, rejectOrder,
  markOnTheWay, markArrived, addOrderItems,
  acceptQuote, markCompleted, confirmOrder,
  getOrder, listOrders,
};