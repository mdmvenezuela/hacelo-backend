const express      = require('express');
const { authenticate, requireAny } = require('../middlewares/auth.middleware');
const { query, transaction } = require('../config/db');
const WalletService = require('../services/wallet.service');

const walletRouter = express.Router();

// GET /wallet — Saldo actual
walletRouter.get('/', authenticate, async (req, res) => {
  try {
    const w = await WalletService.getWallet(req.user.id);
    res.json({ success: true, data: w });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /wallet/transactions — Historial
walletRouter.get('/transactions', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { rows } = await query(`
      SELECT wt.* FROM wallet_transactions wt
      JOIN wallets w ON w.id = wt.wallet_id
      WHERE w.user_id = $1
      ORDER BY wt.created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.user.id, parseInt(limit), offset]);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /wallet/payment-methods — Métodos disponibles para recargar
walletRouter.get('/payment-methods', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM payment_methods WHERE is_active = true ORDER BY sort_order'
    );
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /wallet/recharge — Cliente solicita recarga
walletRouter.post('/recharge', authenticate, async (req, res) => {
  try {
    const { paymentMethodId, amount, referenceNumber, paymentDate, originBank, receiptUrl, notes } = req.body;

    const { rows: pending } = await query(
      `SELECT id FROM recharge_requests WHERE user_id = $1 AND status = 'pending'`,
      [req.user.id]
    );
    if (pending.length >= 3) {
      return res.status(400).json({ success: false, message: 'Tienes 3 recargas pendientes. Espera que sean procesadas.' });
    }

    const wallet = await WalletService.getWallet(req.user.id);
    const { rows: [recharge] } = await query(`
      INSERT INTO recharge_requests
        (user_id, wallet_id, payment_method_id, amount, reference_number, payment_date, origin_bank, receipt_url, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [req.user.id, wallet.id, paymentMethodId, amount, referenceNumber, paymentDate, originBank, receiptUrl, notes]);

    res.status(201).json({ success: true, message: 'Solicitud enviada. Un administrador la revisará pronto.', data: recharge });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /wallet/recharges — Historial de recargas del usuario
walletRouter.get('/recharges', authenticate, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT r.*, pm.name AS method_name
       FROM recharge_requests r
       JOIN payment_methods pm ON pm.id = r.payment_method_id
       WHERE r.user_id = $1
       ORDER BY r.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /wallet/withdrawals — Historial de retiros del usuario
walletRouter.get('/withdrawals', authenticate, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT wr.*, pm.name AS method_name
       FROM withdrawal_requests wr
       LEFT JOIN payment_methods pm ON pm.id = wr.payment_method_id
       WHERE wr.user_id = $1
       ORDER BY wr.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /wallet/withdraw — Proveedor solicita retiro
// Al solicitar: balance baja, blocked_balance sube (escrow)
// Al aprobar (admin): blocked_balance baja, total_withdrawn sube
// Al rechazar (admin): blocked_balance baja, balance sube (devolver)
walletRouter.post('/withdraw', authenticate, async (req, res) => {
  try {
    const { amount, paymentMethodId, payoutDetails } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Monto inválido' });
    }

    // Verificar que no tenga retiros pendientes (máx 1 simultáneo)
    const { rows: pending } = await query(
      `SELECT id FROM withdrawal_requests WHERE user_id = $1 AND status IN ('pending','processing')`,
      [req.user.id]
    );
    if (pending.length >= 1) {
      return res.status(400).json({ success: false, message: 'Ya tienes un retiro pendiente. Espera que sea procesado.' });
    }

    await transaction(async (client) => {
      // Lock wallet
      const { rows: [wallet] } = await client.query(
        'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
        [req.user.id]
      );

      const balanceBefore  = parseFloat(wallet.balance);
      const amt            = parseFloat(amount);

      if (balanceBefore < amt) {
        throw new Error(`Saldo insuficiente. Disponible: $${balanceBefore.toFixed(2)}`);
      }

      const balanceAfter  = balanceBefore - amt;
      const blockedAfter  = parseFloat(wallet.blocked_balance) + amt;

      // Mover de balance a blocked_balance (escrow mientras se procesa)
      await client.query(
        'UPDATE wallets SET balance = $1, blocked_balance = $2 WHERE user_id = $3',
        [balanceAfter, blockedAfter, req.user.id]
      );

      // Registrar transacción pendiente
      await client.query(`
        INSERT INTO wallet_transactions
          (wallet_id, type, status, amount, balance_before, balance_after,
           reference_type, description, metadata)
        VALUES ($1, 'withdrawal', 'pending', $2, $3, $4, 'withdrawal_request',
                $5, $6)
      `, [
        wallet.id, amt, balanceBefore, balanceAfter,
        `Retiro solicitado — en proceso de verificación`,
        JSON.stringify({ payout_details: payoutDetails }),
      ]);

      // Crear solicitud de retiro
      const { rows: [wr] } = await client.query(`
        INSERT INTO withdrawal_requests
          (user_id, wallet_id, amount, payment_method_id, payout_details)
        VALUES ($1, $2, $3, $4, $5) RETURNING *
      `, [req.user.id, wallet.id, amt, paymentMethodId || null, JSON.stringify(payoutDetails || {})]);

      // Actualizar reference_id en la transacción que acabamos de insertar
      await client.query(`
        UPDATE wallet_transactions SET reference_id = $1
        WHERE id = (
          SELECT id FROM wallet_transactions
          WHERE wallet_id = $2 AND type = 'withdrawal' AND status = 'pending'
            AND reference_id IS NULL
          ORDER BY created_at DESC LIMIT 1
        )
      `, [wr.id, wallet.id]);

      return wr;
    });

    res.status(201).json({
      success: true,
      message: 'Solicitud de retiro enviada. Tu saldo está reservado mientras se procesa.',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = walletRouter;