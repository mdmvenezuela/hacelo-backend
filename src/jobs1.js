const { query } = require('../config/db');
const { emitToUser } = require('../config/socket');

const cancelExpiredOrders = async () => {
  try {
    const { rows } = await query(`
      SELECT id, client_id, provider_id, visit_price, order_number
      FROM orders WHERE status = 'requested' AND expires_at IS NOT NULL AND expires_at < NOW()
    `);
    for (const order of rows) {
      await query(`UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = 'Expirada — el proveedor no respondió en 30 minutos' WHERE id = $1`, [order.id]);
      await query(`UPDATE wallets SET balance = balance + $1, blocked_balance = blocked_balance - $1 WHERE user_id = $2`, [order.visit_price, order.client_id]);
      emitToUser(order.client_id, 'order_expired', {
        orderId: order.id, orderNumber: `#${String(order.order_number).padStart(6, '0')}`,
        message: 'Tu solicitud expiró. Tu saldo fue desbloqueado.', refund: order.visit_price,
      });
    }
    if (rows.length > 0) console.log(`✅ ${rows.length} orden(es) expiradas canceladas`);
  } catch (err) { console.error('❌ cancelExpiredOrders:', err.message); }
};

const autoConfirmOrders = async () => {
  try {
    const { rows } = await query(`
      SELECT o.id, o.client_id, o.provider_id, o.work_total, o.commission_rate, o.order_number
      FROM orders o WHERE o.status = 'completed' AND o.confirm_deadline IS NOT NULL AND o.confirm_deadline < NOW()
    `);
    for (const order of rows) {
      const rate       = parseFloat(order.commission_rate || 0.135);
      const commission = parseFloat((order.work_total * rate).toFixed(2));
      const net        = parseFloat((order.work_total - commission).toFixed(2));
      await query(`UPDATE orders SET status = 'confirmed', confirmed_at = NOW(), work_paid = true, work_paid_at = NOW() WHERE id = $1`, [order.id]);
      await query(`UPDATE wallets SET blocked_balance = blocked_balance - $1 WHERE user_id = $2`, [order.work_total, order.client_id]);
      await query(`UPDATE wallets SET balance = balance + $1, total_earned = total_earned + $1 WHERE user_id = $2`, [net, order.provider_id]);
      // FIX: cast explícito a provider_level
      await query(`
        UPDATE provider_profiles SET points = points + 1, orders_completed = orders_completed + 1,
        level = CASE WHEN points+1 > 200 THEN 'oro'::provider_level WHEN points+1 > 50 THEN 'plata'::provider_level ELSE 'lila'::provider_level END
        WHERE user_id = $1
      `, [order.provider_id]);
      emitToUser(order.provider_id, 'order_auto_confirmed', { orderId: order.id, netEarned: net, message: `Pago de $${net} liberado automáticamente.` });
    }
  } catch (err) { console.error('❌ autoConfirmOrders:', err.message); }
};

const initJobs = () => {
  setInterval(cancelExpiredOrders, 2 * 60 * 1000);
  setInterval(autoConfirmOrders,   5 * 60 * 1000);
  cancelExpiredOrders();
  autoConfirmOrders();
  console.log('⚙️  Jobs iniciados');
};

module.exports = { initJobs };
