// ══════════════════════════════════════════════════════════════
// HACELO — Jobs en background
// Corre automáticamente cada 2 min (cancelar) / 5 min (confirmar)
// ══════════════════════════════════════════════════════════════
const { query, transaction } = require('./config/db');
const { emitToUser }         = require('./config/socket');

// ── Helper: registrar transacción ────────────────────────────
async function logTx(client, {
  walletId, type, status = 'approved',
  amount, balanceBefore, balanceAfter,
  referenceId = null, referenceType = 'order',
  description = null,
}) {
  await client.query(`
    INSERT INTO wallet_transactions
      (wallet_id, type, status, amount, balance_before, balance_after,
       reference_id, reference_type, description)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  `, [walletId, type, status, amount, balanceBefore, balanceAfter,
      referenceId, referenceType, description]);
}

// ── Job 1: Cancelar órdenes expiradas ────────────────────────
const cancelExpiredOrders = async () => {
  try {
    const { rows: expired } = await query(`
      SELECT id, client_id, provider_id, visit_price, order_number
      FROM orders
      WHERE status = 'requested'
        AND expires_at IS NOT NULL
        AND expires_at < NOW()
    `);

    for (const order of expired) {
      await transaction(async (client) => {
        // 1. Cancelar la orden
        await client.query(`
          UPDATE orders
          SET status = 'cancelled', cancelled_at = NOW(),
              cancel_reason = 'Expirada — el proveedor no respondió en 30 minutos'
          WHERE id = $1
        `, [order.id]);

        // 2. Obtener wallet del cliente
        const { rows: [clientWallet] } = await client.query(
          'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
          [order.client_id]
        );

        const blocked     = parseFloat(clientWallet.blocked_balance);
        const visitPrice  = parseFloat(order.visit_price);
        const newBlocked  = Math.max(0, blocked - visitPrice);
        const newBalance  = parseFloat(clientWallet.balance) + visitPrice;

        // 3. Desbloquear el dinero del cliente
        await client.query(`
          UPDATE wallets
          SET balance = $1, blocked_balance = $2
          WHERE user_id = $3
        `, [newBalance, newBlocked, order.client_id]);

        // 4. Registrar transacción de devolución (visit_unblock)
        await logTx(client, {
          walletId:      clientWallet.id,
          type:          'visit_unblock',
          amount:        visitPrice,
          balanceBefore: parseFloat(clientWallet.balance),
          balanceAfter:  newBalance,
          referenceId:   order.id,
          description:   `Devolución automática — Orden #${String(order.order_number).padStart(6,'0')} expirada`,
        });
      });

      // Notificar al cliente
      emitToUser(order.client_id, 'order_expired', {
        orderId:     order.id,
        orderNumber: `#${String(order.order_number).padStart(6,'0')}`,
        message:     'Tu solicitud expiró porque el proveedor no respondió. Tu saldo fue devuelto automáticamente.',
        refund:      order.visit_price,
      });

      console.log(`⏰ Orden #${order.order_number} expirada — saldo devuelto al cliente`);
    }

    if (expired.length > 0) {
      console.log(`✅ ${expired.length} orden(es) expiradas procesadas`);
    }
  } catch (err) {
    console.error('❌ cancelExpiredOrders:', err.message);
  }
};

// ── Job 2: Auto-confirmar órdenes completadas sin respuesta ──
const autoConfirmOrders = async () => {
  try {
    const { rows: completed } = await query(`
      SELECT o.id, o.client_id, o.provider_id, o.work_total,
             o.commission_rate, o.order_number
      FROM orders o
      WHERE o.status = 'completed'
        AND o.confirm_deadline IS NOT NULL
        AND o.confirm_deadline < NOW()
    `);

    for (const order of completed) {
      await transaction(async (client) => {
        const rate       = parseFloat(order.commission_rate || 0.135);
        const gross      = parseFloat(order.work_total);
        const commission = parseFloat((gross * rate).toFixed(2));
        const net        = parseFloat((gross - commission).toFixed(2));

        // 1. Confirmar la orden
        await client.query(`
          UPDATE orders
          SET status = 'confirmed', confirmed_at = NOW(),
              work_paid = true, work_paid_at = NOW(),
              commission_amount = COALESCE(commission_amount, 0) + $1
          WHERE id = $2
        `, [commission, order.id]);

        // 2. Wallet del cliente — quitar del bloqueado (ya se cobró antes en work_block)
        const { rows: [clientWallet] } = await client.query(
          'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
          [order.client_id]
        );
        const clientNewBlocked = Math.max(0, parseFloat(clientWallet.blocked_balance) - gross);
        await client.query(
          'UPDATE wallets SET blocked_balance = $1 WHERE user_id = $2',
          [clientNewBlocked, order.client_id]
        );

        // Registrar como cobro real para el cliente (work_release)
        await logTx(client, {
          walletId:      clientWallet.id,
          type:          'work_release',
          amount:        gross,
          balanceBefore: parseFloat(clientWallet.balance),
          balanceAfter:  parseFloat(clientWallet.balance), // balance no cambia, era blocked
          referenceId:   order.id,
          description:   `Trabajo auto-confirmado — Orden #${String(order.order_number).padStart(6,'0')}`,
        });

        // 3. Wallet del proveedor — acreditar neto
        const { rows: [provWallet] } = await client.query(
          'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
          [order.provider_id]
        );
        const provNewBalance = parseFloat(provWallet.balance) + net;
        await client.query(
          'UPDATE wallets SET balance = $1, total_earned = total_earned + $2 WHERE user_id = $3',
          [provNewBalance, net, order.provider_id]
        );

        // Registrar ingreso para el proveedor (work_release)
        await logTx(client, {
          walletId:      provWallet.id,
          type:          'work_release',
          amount:        net,
          balanceBefore: parseFloat(provWallet.balance),
          balanceAfter:  provNewBalance,
          referenceId:   order.id,
          description:   `Pago auto-confirmado — Orden #${String(order.order_number).padStart(6,'0')}`,
        });

        // Registrar comisión del proveedor
        await logTx(client, {
          walletId:      provWallet.id,
          type:          'commission',
          amount:        commission,
          balanceBefore: provNewBalance,
          balanceAfter:  provNewBalance, // ya está descontada del net
          referenceId:   order.id,
          description:   `Comisión Hacelo (${(rate*100).toFixed(1)}%) — Orden #${String(order.order_number).padStart(6,'0')}`,
        });

        // 4. Sumar puntos al proveedor con cast correcto
        await client.query(`
          UPDATE provider_profiles
          SET points = points + 1,
              orders_completed = orders_completed + 1,
              level = CASE
                WHEN points + 1 > 200 THEN 'oro'::provider_level
                WHEN points + 1 > 50  THEN 'plata'::provider_level
                ELSE 'lila'::provider_level
              END
          WHERE user_id = $1
        `, [order.provider_id]);
      });

      // Notificar al proveedor
      emitToUser(order.provider_id, 'order_auto_confirmed', {
        orderId:     order.id,
        orderNumber: `#${String(order.order_number).padStart(6,'0')}`,
        message:     `Pago de $${(parseFloat(order.work_total) * (1 - parseFloat(order.commission_rate || 0.135))).toFixed(2)} liberado automáticamente. El cliente no respondió en 48h.`,
      });

      console.log(`✅ Orden #${order.order_number} auto-confirmada — pago liberado al proveedor`);
    }

    if (completed.length > 0) {
      console.log(`✅ ${completed.length} orden(es) auto-confirmadas`);
    }
  } catch (err) {
    console.error('❌ autoConfirmOrders:', err.message);
  }
};

// ── Inicializar ───────────────────────────────────────────────
const initJobs = () => {
  setInterval(cancelExpiredOrders, 2 * 60 * 1000);   // cada 2 min
  setInterval(autoConfirmOrders,   5 * 60 * 1000);   // cada 5 min

  // Correr inmediatamente al iniciar
  cancelExpiredOrders();
  autoConfirmOrders();

  console.log('⚙️  Jobs iniciados: cancelación cada 2min · auto-confirmación cada 5min');
};

module.exports = { initJobs };