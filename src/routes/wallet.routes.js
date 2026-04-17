// wallet.routes.js
const express = require('express');
const { authenticate, requireAdmin, requireAny } = require('../middlewares/auth.middleware');
const { query, transaction } = require('../config/db');
const WalletService = require('../services/wallet.service');

const walletRouter = express.Router();

// GET /wallet — Saldo actual
walletRouter.get('/', authenticate, async (req, res) => {
  const w = await WalletService.getWallet(req.user.id);
  res.json({ success: true, data: w });
});

// GET /wallet/transactions — Historial
walletRouter.get('/transactions', authenticate, async (req, res) => {
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
});

// GET /wallet/payment-methods — Métodos disponibles para recargar
walletRouter.get('/payment-methods', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM payment_methods WHERE is_active = true ORDER BY sort_order'
  );
  res.json({ success: true, data: rows });
});

// POST /wallet/recharge — Cliente solicita recarga
walletRouter.post('/recharge', authenticate, async (req, res) => {
  const { paymentMethodId, amount, referenceNumber, paymentDate, originBank, receiptUrl, notes } = req.body;

  // Máximo 3 recargas pendientes simultáneas
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
});

// GET /wallet/recharges — Historial de recargas del usuario
walletRouter.get('/recharges', authenticate, async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, pm.name as method_name FROM recharge_requests r
     JOIN payment_methods pm ON pm.id = r.payment_method_id
     WHERE r.user_id = $1 ORDER BY r.created_at DESC`,
    [req.user.id]
  );
  res.json({ success: true, data: rows });
});

// POST /wallet/withdraw — Proveedor solicita retiro
walletRouter.post('/withdraw', authenticate, async (req, res) => {
  const { amount, paymentMethodId, payoutDetails } = req.body;
  const wallet = await WalletService.getWallet(req.user.id);

  if (parseFloat(wallet.balance) < parseFloat(amount)) {
    return res.status(400).json({ success: false, message: 'Saldo insuficiente para retirar' });
  }

  const { rows: [wr] } = await query(`
    INSERT INTO withdrawal_requests (user_id, wallet_id, amount, payment_method_id, payout_details)
    VALUES ($1,$2,$3,$4,$5) RETURNING *
  `, [req.user.id, wallet.id, amount, paymentMethodId, JSON.stringify(payoutDetails)]);

  res.status(201).json({ success: true, message: 'Solicitud de retiro enviada.', data: wr });
});

module.exports = walletRouter;