// ══════════════════════════════════════════════════════════════
// src/routes/admin.routes.js
// ══════════════════════════════════════════════════════════════
const express      = require('express');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const { query, transaction } = require('../config/db');
const push         = require('../services/pushNotifications');

const router = express.Router();
const ADMIN_SECRET = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET + '_admin';

// ── Middleware auth admin ─────────────────────────────────────
const adminAuth = (roles = ['admin', 'moderator', 'conciliator']) => async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
      return res.status(401).json({ success: false, message: 'Sin autorización' });

    const payload = jwt.verify(header.split(' ')[1], ADMIN_SECRET);
    const { rows: [admin] } = await query(
      'SELECT id, email, full_name, role, is_active FROM admin_users WHERE id = $1',
      [payload.adminId]
    );

    if (!admin || !admin.is_active)
      return res.status(401).json({ success: false, message: 'Administrador no válido' });
    if (!roles.includes(admin.role))
      return res.status(403).json({ success: false, message: 'Sin permiso para esta acción' });

    req.admin = admin;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Token inválido' });
  }
};

// ════════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════════

router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ success: false, message: 'Email y contraseña requeridos' });

    const { rows: [admin] } = await query(
      'SELECT * FROM admin_users WHERE email = $1 AND is_active = true',
      [email.toLowerCase()]
    );
    if (!admin)
      return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid)
      return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });

    await query('UPDATE admin_users SET last_login = NOW() WHERE id = $1', [admin.id]);

    const token = jwt.sign({ adminId: admin.id, role: admin.role }, ADMIN_SECRET, { expiresIn: '8h' });

    res.json({
      success: true,
      data: {
        token,
        admin: { id: admin.id, email: admin.email, fullName: admin.full_name, role: admin.role },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/auth/me', adminAuth(), (req, res) => {
  res.json({ success: true, data: req.admin });
});

// ════════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════════

router.get('/dashboard', adminAuth(['admin', 'moderator']), async (req, res) => {
  try {
    const [users, orders, recharges, wallets, withdrawals] = await Promise.all([
      query(`
        SELECT
          COUNT(*) FILTER (WHERE role = 'client')   AS clients,
          COUNT(*) FILTER (WHERE role = 'provider') AS providers,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS new_this_week
        FROM users WHERE role != 'admin'
      `),
      query(`
        SELECT
          COUNT(*)                                                          AS total,
          COUNT(*) FILTER (WHERE status = 'requested')                     AS pending,
          COUNT(*) FILTER (WHERE status::text IN ('accepted','in_conversation',
            'on_the_way','diagnosing','quote_sent','in_progress'))          AS in_progress,
          COUNT(*) FILTER (WHERE status = 'completed')                     AS completed,
          COUNT(*) FILTER (WHERE status = 'confirmed')                     AS confirmed,
          COUNT(*) FILTER (WHERE status = 'cancelled')                     AS cancelled,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')  AS this_week
        FROM orders
      `),
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')  AS pending,
          COUNT(*) FILTER (WHERE status = 'approved') AS approved,
          COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
          SUM(amount) FILTER (WHERE status = 'approved') AS total_approved_amount
        FROM recharge_requests
      `),
      query(`
        SELECT SUM(balance) AS total_balance, SUM(blocked_balance) AS total_blocked FROM wallets
      `),
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')           AS pending,
          COUNT(*) FILTER (WHERE status = 'completed')         AS completed,
          SUM(amount) FILTER (WHERE status = 'pending')        AS pending_amount,
          SUM(amount) FILTER (WHERE status = 'completed')      AS completed_amount
        FROM withdrawal_requests
      `),
    ]);

    res.json({
      success: true,
      data: {
        users:       users.rows[0],
        orders:      orders.rows[0],
        recharges:   recharges.rows[0],
        wallet:      wallets.rows[0],
        withdrawals: withdrawals.rows[0],
      },
    });
  } catch (err) {
    console.error('dashboard error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// USUARIOS
// ════════════════════════════════════════════════════════════════

router.get('/users', adminAuth(['admin', 'moderator']), async (req, res) => {
  try {
    const { search, role, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = ["u.role != 'admin'"];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
    }
    if (role) {
      params.push(role);
      conditions.push(`u.role = $${params.length}`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const { rows } = await query(`
      SELECT
        u.id, u.email, u.full_name, u.phone, u.role,
        u.is_active, u.is_verified, u.avatar_url, u.created_at,
        w.balance, w.blocked_balance,
        pp.kyc_status, pp.rating_avg, pp.orders_completed
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.id
      LEFT JOIN provider_profiles pp ON pp.user_id = u.id
      ${where}
      ORDER BY u.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    const { rows: [{ count }] } = await query(
      `SELECT COUNT(*) FROM users u ${where}`, params
    );

    res.json({ success: true, data: rows, total: parseInt(count) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/users/:id', adminAuth(['admin', 'moderator']), async (req, res) => {
  try {
    const { isActive } = req.body;
    await query('UPDATE users SET is_active = $1 WHERE id = $2', [isActive, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// KYC — tabla: provider_kyc
// reviewed_by apunta a admin_users (después del fix SQL)
// ════════════════════════════════════════════════════════════════

router.get('/kyc', adminAuth(['admin', 'moderator']), async (req, res) => {
  try {
    const { status = 'pending', page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const { rows } = await query(`
      SELECT
        k.id, k.user_id, k.status, k.submitted_at, k.reviewed_at,
        k.rejection_reason,
        k.selfie_url, k.id_front_url, k.id_back_url,
        k.rif_url, k.video_selfie_url,
        k.full_name_doc, k.id_number, k.rif_number,
        u.full_name, u.email, u.phone,
        a.full_name AS reviewed_by_name
      FROM provider_kyc k
      JOIN users u ON u.id = k.user_id
      LEFT JOIN admin_users a ON a.id = k.reviewed_by
      WHERE k.status = $1
      ORDER BY k.submitted_at ASC
      LIMIT $2 OFFSET $3
    `, [status, limit, offset]);

    const { rows: [{ count }] } = await query(
      'SELECT COUNT(*) FROM provider_kyc WHERE status = $1', [status]
    );

    res.json({ success: true, data: rows, total: parseInt(count) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/kyc/:id/approve', adminAuth(['admin', 'moderator']), async (req, res) => {
  try {
    const { rows: [kyc] } = await query(
      `UPDATE provider_kyc
       SET status = 'approved', reviewed_at = NOW(), reviewed_by = $1
       WHERE id = $2 RETURNING user_id`,
      [req.admin.id, req.params.id]
    );
    if (!kyc) return res.status(404).json({ success: false, message: 'KYC no encontrado' });

    await query('UPDATE users SET is_verified = true WHERE id = $1', [kyc.user_id]);
    await query(
      `UPDATE provider_profiles SET is_verified = true, kyc_status = 'approved' WHERE user_id = $1`,
      [kyc.user_id]
    );

    push.notifyKYCApproved(kyc.user_id).catch(() => {});
    res.json({ success: true, message: 'KYC aprobado' });
  } catch (err) {
    console.error('kyc approve error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/kyc/:id/reject', adminAuth(['admin', 'moderator']), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Motivo requerido' });

    const { rows: [kyc] } = await query(
      `UPDATE provider_kyc
       SET status = 'rejected', reviewed_at = NOW(),
           reviewed_by = $1, rejection_reason = $2
       WHERE id = $3 RETURNING user_id`,
      [req.admin.id, reason, req.params.id]
    );
    if (!kyc) return res.status(404).json({ success: false, message: 'KYC no encontrado' });

    await query(
      `UPDATE provider_profiles SET kyc_status = 'rejected' WHERE user_id = $1`,
      [kyc.user_id]
    );

    push.notifyKYCRejected(kyc.user_id, reason).catch(() => {});
    res.json({ success: true, message: 'KYC rechazado' });
  } catch (err) {
    console.error('kyc reject error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// ÓRDENES
// ════════════════════════════════════════════════════════════════

router.get('/orders', adminAuth(['admin', 'moderator']), async (req, res) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];

    if (status) {
      params.push(status);
      conditions.push(`o.status::text = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(uc.full_name ILIKE $${params.length} OR up.full_name ILIKE $${params.length} OR o.title ILIKE $${params.length})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await query(`
      SELECT
        o.id, o.order_number, o.title, o.status::text AS status,
        o.visit_price, o.work_total, o.is_urgent,
        o.created_at, o.confirmed_at, o.commission_amount,
        uc.full_name AS client_name, uc.email AS client_email,
        up.full_name AS provider_name,
        cat.name     AS category_name
      FROM orders o
      JOIN users uc ON uc.id = o.client_id
      LEFT JOIN users up ON up.id = o.provider_id
      LEFT JOIN categories cat ON cat.id = o.category_id
      ${where}
      ORDER BY o.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    const { rows: [{ count }] } = await query(`
      SELECT COUNT(*) FROM orders o
      JOIN users uc ON uc.id = o.client_id
      LEFT JOIN users up ON up.id = o.provider_id
      ${where}
    `, params);

    res.json({ success: true, data: rows, total: parseInt(count) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// RECARGAS — tabla: recharge_requests
// reviewed_by apunta a admin_users (después del fix SQL)
// ════════════════════════════════════════════════════════════════

router.get('/recharges', adminAuth(['admin', 'moderator', 'conciliator']), async (req, res) => {
  try {
    const { status = 'pending', page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const { rows } = await query(`
      SELECT
        r.id, r.user_id, r.amount, r.status::text AS status,
        r.reference_number, r.payment_date,
        r.origin_bank, r.notes, r.created_at,
        r.reviewed_at, r.admin_notes AS rejection_reason,
        u.full_name, u.email, u.phone,
        pm.name AS payment_method_name,
        pm.type::text AS payment_method_type,
        a.full_name AS reviewed_by_name
      FROM recharge_requests r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN payment_methods pm ON pm.id = r.payment_method_id
      LEFT JOIN admin_users a ON a.id = r.reviewed_by
      WHERE r.status::text = $1
      ORDER BY r.created_at ASC
      LIMIT $2 OFFSET $3
    `, [status, limit, offset]);

    const { rows: [{ count }] } = await query(
      'SELECT COUNT(*) FROM recharge_requests WHERE status::text = $1', [status]
    );

    res.json({ success: true, data: rows, total: parseInt(count) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /admin/recharges/:id/approve — usa WalletService para registrar transacción
router.post('/recharges/:id/approve', adminAuth(['admin', 'moderator', 'conciliator']), async (req, res) => {
  try {
    const { rows: [recharge] } = await query(
      "SELECT * FROM recharge_requests WHERE id = $1 AND status = 'pending'",
      [req.params.id]
    );
    if (!recharge) return res.status(404).json({ success: false, message: 'Recarga no encontrada o ya procesada' });

    // Usar transaction para acreditar saldo + registrar en wallet_transactions
    await transaction(async (client) => {
      // Obtener wallet del usuario con lock
      const { rows: [wallet] } = await client.query(
        'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
        [recharge.user_id]
      );

      const balanceBefore = parseFloat(wallet.balance);
      const amount        = parseFloat(recharge.amount);
      const balanceAfter  = balanceBefore + amount;

      // Acreditar saldo
      await client.query(
        'UPDATE wallets SET balance = $1 WHERE user_id = $2',
        [balanceAfter, recharge.user_id]
      );

      // Registrar en wallet_transactions (igual que WalletService.credit)
      await client.query(`
        INSERT INTO wallet_transactions
          (wallet_id, type, status, amount, balance_before, balance_after,
           reference_id, reference_type, description, metadata)
        VALUES ($1, 'recharge', 'approved', $2, $3, $4, $5, 'recharge_request', $6, $7)
      `, [
        wallet.id,
        amount,
        balanceBefore,
        balanceAfter,
        recharge.id,
        `Recarga aprobada por: ${req.admin.full_name}`,
        JSON.stringify({ admin_id: req.admin.id, admin_name: req.admin.full_name }),
      ]);

      // Marcar recarga como aprobada con el admin que la procesó
      await client.query(
        `UPDATE recharge_requests
         SET status = 'approved', reviewed_at = NOW(), reviewed_by = $1,
             admin_notes = $2
         WHERE id = $3`,
        [req.admin.id, `Aprobado por: ${req.admin.full_name}`, recharge.id]
      );
    });

    push.notifyRechargeApproved(recharge.user_id, recharge.amount).catch(() => {});
    res.json({ success: true, message: 'Recarga aprobada y saldo acreditado' });
  } catch (err) {
    console.error('recharge approve error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/recharges/:id/reject', adminAuth(['admin', 'moderator', 'conciliator']), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Motivo requerido' });

    const { rows: [recharge] } = await query(
      "SELECT * FROM recharge_requests WHERE id = $1 AND status = 'pending'",
      [req.params.id]
    );
    if (!recharge) return res.status(404).json({ success: false, message: 'Recarga no encontrada o ya procesada' });

    await query(
      `UPDATE recharge_requests
       SET status = 'rejected', reviewed_at = NOW(),
           reviewed_by = $1, admin_notes = $2
       WHERE id = $3`,
      [req.admin.id, reason, recharge.id]
    );

    push.notifyRechargeRejected(recharge.user_id, reason).catch(() => {});
    res.json({ success: true, message: 'Recarga rechazada' });
  } catch (err) {
    console.error('recharge reject error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// RETIROS — tabla: withdrawal_requests
// ════════════════════════════════════════════════════════════════

router.get('/withdrawals', adminAuth(['admin', 'moderator', 'conciliator']), async (req, res) => {
  try {
    const { status = 'pending', page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const { rows } = await query(`
      SELECT
        w.id, w.user_id, w.amount, w.status::text AS status,
        w.payout_details, w.created_at, w.processed_at,
        w.admin_notes,
        u.full_name, u.email, u.phone,
        pm.name AS payment_method_name,
        pm.type::text AS payment_method_type,
        wa.balance AS current_balance,
        a.full_name AS processed_by_name
      FROM withdrawal_requests w
      JOIN users u ON u.id = w.user_id
      LEFT JOIN payment_methods pm ON pm.id = w.payment_method_id
      LEFT JOIN wallets wa ON wa.user_id = w.user_id
      LEFT JOIN admin_users a ON a.id = w.processed_by
      WHERE w.status::text = $1
      ORDER BY w.created_at ASC
      LIMIT $2 OFFSET $3
    `, [status, limit, offset]);

    const { rows: [{ count }] } = await query(
      'SELECT COUNT(*) FROM withdrawal_requests WHERE status::text = $1', [status]
    );

    res.json({ success: true, data: rows, total: parseInt(count) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/withdrawals/:id/approve', adminAuth(['admin', 'moderator', 'conciliator']), async (req, res) => {
  try {
    const { rows: [wr] } = await query(
      "SELECT * FROM withdrawal_requests WHERE id = $1 AND status IN ('pending','processing')",
      [req.params.id]
    );
    if (!wr) return res.status(404).json({ success: false, message: 'Retiro no encontrado o ya procesado' });

    await transaction(async (client) => {
      const { rows: [wallet] } = await client.query(
        'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
        [wr.user_id]
      );

      const amount       = parseFloat(wr.amount);
      const balanceNow   = parseFloat(wallet.balance);
      // El balance ya fue descontado cuando el proveedor solicitó el retiro.
      // Aquí solo sumamos a total_withdrawn para registrar el egreso definitivo.
      await client.query(
        'UPDATE wallets SET total_withdrawn = total_withdrawn + $1 WHERE user_id = $2',
        [amount, wr.user_id]
      );

      // Registrar transacción de débito (withdrawal aprobado)
      await client.query(`
        INSERT INTO wallet_transactions
          (wallet_id, type, status, amount, balance_before, balance_after,
           reference_id, reference_type, description, metadata)
        VALUES ($1, 'withdrawal', 'approved', $2, $3, $3, $4, 'withdrawal_request', $5, $6)
      `, [
        wallet.id,
        amount,
        balanceNow, // balance no cambia aquí, ya bajó al solicitar
        wr.id,
        `Retiro de $${amount.toFixed(2)} aprobado por: ${req.admin.full_name}`,
        JSON.stringify({ admin_id: req.admin.id, admin_name: req.admin.full_name }),
      ]);

      await client.query(
        `UPDATE withdrawal_requests
         SET status = 'completed', processed_at = NOW(), processed_by = $1,
             admin_notes = $2
         WHERE id = $3`,
        [req.admin.id, `Aprobado por: ${req.admin.full_name}`, wr.id]
      );
    });

    push.sendPushToUser(wr.user_id, {
      title: '💵 Retiro completado',
      body:  `Tu retiro de $${parseFloat(wr.amount).toFixed(2)} fue procesado exitosamente.`,
      data:  { screen: 'wallet' },
    }).catch(() => {});

    res.json({ success: true, message: 'Retiro aprobado' });
  } catch (err) {
    console.error('withdrawal approve error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/withdrawals/:id/reject', adminAuth(['admin', 'moderator', 'conciliator']), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Motivo requerido' });

    const { rows: [wr] } = await query(
      "SELECT * FROM withdrawal_requests WHERE id = $1 AND status IN ('pending','processing')",
      [req.params.id]
    );
    if (!wr) return res.status(404).json({ success: false, message: 'Retiro no encontrado o ya procesado' });

    await transaction(async (client) => {
      const { rows: [wallet] } = await client.query(
        'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
        [wr.user_id]
      );

      const amount        = parseFloat(wr.amount);
      const balanceBefore = parseFloat(wallet.balance);
      const balanceAfter  = parseFloat((balanceBefore + amount).toFixed(2));

      // Devolver el saldo que fue descontado al solicitar
      await client.query(
        'UPDATE wallets SET balance = $1 WHERE user_id = $2',
        [balanceAfter, wr.user_id]
      );

      // Registrar transacción de reembolso (refund)
      await client.query(`
        INSERT INTO wallet_transactions
          (wallet_id, type, status, amount, balance_before, balance_after,
           reference_id, reference_type, description, metadata)
        VALUES ($1, 'refund', 'approved', $2, $3, $4, $5, 'withdrawal_request', $6, $7)
      `, [
        wallet.id,
        amount,
        balanceBefore,
        balanceAfter,
        wr.id,
        `Reembolso de retiro rechazado. Motivo: ${reason}`,
        JSON.stringify({ admin_id: req.admin.id, admin_name: req.admin.full_name, reason }),
      ]);

      await client.query(
        `UPDATE withdrawal_requests
         SET status = 'rejected', processed_at = NOW(),
             processed_by = $1, admin_notes = $2
         WHERE id = $3`,
        [req.admin.id, reason, wr.id]
      );
    });

    push.sendPushToUser(wr.user_id, {
      title: '↩️ Retiro rechazado — saldo devuelto',
      body:  `Tu retiro de $${parseFloat(wr.amount).toFixed(2)} fue rechazado y tu saldo fue restaurado. Motivo: ${reason}`,
      data:  { screen: 'wallet' },
    }).catch(() => {});

    res.json({ success: true, message: 'Retiro rechazado y saldo devuelto al proveedor' });
  } catch (err) {
    console.error('withdrawal reject error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// MÉTODOS DE PAGO — tabla: payment_methods
// ════════════════════════════════════════════════════════════════

router.get('/payment-methods', adminAuth(['admin', 'moderator']), async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM payment_methods ORDER BY sort_order, created_at'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/payment-methods', adminAuth(['admin']), async (req, res) => {
  try {
    const {
      name, type, currency = 'USD', instructions,
      fields = [], minAmount = 1, maxAmount = 1000,
      verificationTime = '1-4 horas', sortOrder = 0,
    } = req.body;
    if (!name || !type)
      return res.status(400).json({ success: false, message: 'name y type son requeridos' });

    const { rows: [pm] } = await query(`
      INSERT INTO payment_methods
        (name, type, currency, instructions, fields, min_amount, max_amount, verification_time, sort_order)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
      RETURNING *
    `, [
      name, type, currency, instructions || null,
      JSON.stringify(Array.isArray(fields) ? fields : []),
      minAmount, maxAmount, verificationTime, sortOrder,
    ]);

    res.status(201).json({ success: true, data: pm });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/payment-methods/:id', adminAuth(['admin']), async (req, res) => {
  try {
    const { name, instructions, minAmount, maxAmount, verificationTime, isActive, sortOrder, fields } = req.body;

    // fields puede ser array o null — si viene lo serializamos como JSONB
    const fieldsJson = fields !== undefined ? JSON.stringify(fields) : null;

    await query(`
      UPDATE payment_methods SET
        name              = COALESCE($1, name),
        instructions      = COALESCE($2, instructions),
        min_amount        = COALESCE($3, min_amount),
        max_amount        = COALESCE($4, max_amount),
        verification_time = COALESCE($5, verification_time),
        is_active         = COALESCE($6, is_active),
        sort_order        = COALESCE($7, sort_order),
        fields            = COALESCE($8::jsonb, fields),
        updated_at        = NOW()
      WHERE id = $9
    `, [
      name ?? null,
      instructions ?? null,
      minAmount ?? null,
      maxAmount ?? null,
      verificationTime ?? null,
      isActive ?? null,
      sortOrder ?? null,
      fieldsJson,
      req.params.id,
    ]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/payment-methods/:id', adminAuth(['admin']), async (req, res) => {
  try {
    await query('UPDATE payment_methods SET is_active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Método desactivado' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// ════════════════════════════════════════════════════════════════
// SECTORES — vinculados a zonas
// ════════════════════════════════════════════════════════════════

router.get('/sectors', adminAuth(['admin', 'moderator']), async (req, res) => {
  try {
    const { zoneId } = req.query;
    const params = [];
    let where = '';
    if (zoneId) { params.push(zoneId); where = 'WHERE s.zone_id = $1'; }

    const { rows } = await query(`
      SELECT s.*, z.name AS zone_name
      FROM sectors s
      JOIN zones z ON z.id = s.zone_id
      ${where}
      ORDER BY z.name, s.sort_order, s.name
    `, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/sectors', adminAuth(['admin']), async (req, res) => {
  try {
    const { zoneId, name, slug, sortOrder = 0 } = req.body;
    if (!zoneId || !name || !slug)
      return res.status(400).json({ success: false, message: 'zoneId, name y slug son requeridos' });

    const { rows: [sector] } = await query(`
      INSERT INTO sectors (zone_id, name, slug, sort_order)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [zoneId, name, slug.toLowerCase().replace(/\s+/g, '-'), sortOrder]);

    res.status(201).json({ success: true, data: sector });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ success: false, message: 'Ya existe un sector con ese slug en esta zona' });
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/sectors/:id', adminAuth(['admin']), async (req, res) => {
  try {
    const { name, isActive, sortOrder } = req.body;
    await query(`
      UPDATE sectors SET
        name       = COALESCE($1, name),
        is_active  = COALESCE($2, is_active),
        sort_order = COALESCE($3, sort_order)
      WHERE id = $4
    `, [name ?? null, isActive ?? null, sortOrder ?? null, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/sectors/:id', adminAuth(['admin']), async (req, res) => {
  try {
    await query('UPDATE sectors SET is_active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// ADMINS — solo admin
// ════════════════════════════════════════════════════════════════

router.get('/admins', adminAuth(['admin']), async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id, email, full_name, role, is_active, created_at, last_login FROM admin_users ORDER BY created_at DESC'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/admins', adminAuth(['admin']), async (req, res) => {
  try {
    const { email, password, fullName, role } = req.body;
    if (!email || !password || !fullName || !role)
      return res.status(400).json({ success: false, message: 'Todos los campos son requeridos' });
    if (!['admin', 'moderator', 'conciliator'].includes(role))
      return res.status(400).json({ success: false, message: 'Rol inválido' });

    const hash = await bcrypt.hash(password, 12);
    const { rows: [admin] } = await query(
      `INSERT INTO admin_users (email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, full_name, role`,
      [email.toLowerCase(), hash, fullName, role]
    );
    res.status(201).json({ success: true, data: admin });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ success: false, message: 'Ya existe un admin con ese email' });
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/admins/:id', adminAuth(['admin']), async (req, res) => {
  try {
    const { isActive, role } = req.body;
    await query(
      'UPDATE admin_users SET is_active = COALESCE($1, is_active), role = COALESCE($2, role) WHERE id = $3',
      [isActive ?? null, role ?? null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// FINANZAS — resumen financiero con filtros por fecha
// ════════════════════════════════════════════════════════════════

router.get('/finance', adminAuth(['admin', 'moderator']), async (req, res) => {
  try {
    const { from, to } = req.query;

    const buildDateFilter = (col, startIdx) => {
      if (from && to)  return `AND ${col} BETWEEN $${startIdx} AND $${startIdx+1}`;
      if (from || to)  return `AND ${col} >= $${startIdx}`;
      return '';
    };
    const dateParams = from && to ? [from, to] : (from || to) ? [from || to] : [];
    const dp = dateParams;

    const [recharges, withdrawals, commissions, wallets, byRole, txSummary, topProviders] = await Promise.all([
      query(`SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS total
             FROM recharge_requests WHERE status='approved' ${buildDateFilter('reviewed_at', 1)}`, dp),

      query(`SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS total
             FROM withdrawal_requests WHERE status='completed' ${buildDateFilter('processed_at', 1)}`, dp),

      query(`SELECT COUNT(*) AS orders_count,
               COALESCE(SUM(commission_amount),0) AS total_commission,
               COALESCE(SUM(visit_price),0)       AS total_visit_revenue,
               COALESCE(SUM(work_total),0)        AS total_work_volume
             FROM orders WHERE status IN ('confirmed','completed') AND commission_amount > 0
             ${buildDateFilter('confirmed_at', 1)}`, dp),

      query(`SELECT COALESCE(SUM(balance),0)         AS total_client_balance,
               COALESCE(SUM(blocked_balance),0)  AS total_blocked,
               COALESCE(SUM(total_earned),0)      AS total_earned_providers,
               COALESCE(SUM(total_withdrawn),0)   AS total_withdrawn_providers
             FROM wallets`, []),

      query(`SELECT u.role, COALESCE(SUM(w.balance),0) AS balance,
               COALESCE(SUM(w.blocked_balance),0) AS blocked, COUNT(*) AS count
             FROM wallets w JOIN users u ON u.id=w.user_id GROUP BY u.role`, []),

      query(`SELECT type, status, COUNT(*) AS count, COALESCE(SUM(amount),0) AS total
             FROM wallet_transactions wt JOIN wallets w ON w.id=wt.wallet_id
             WHERE 1=1 ${buildDateFilter('wt.created_at', 1)}
             GROUP BY type,status ORDER BY type,status`, dp),

      query(`SELECT u.full_name, u.email,
               COALESCE(w.total_earned,0) AS total_earned,
               COALESCE(w.total_withdrawn,0) AS total_withdrawn,
               COALESCE(w.balance,0) AS current_balance,
               pp.orders_completed
             FROM wallets w JOIN users u ON u.id=w.user_id
             JOIN provider_profiles pp ON pp.user_id=u.id
             WHERE u.role='provider' ORDER BY w.total_earned DESC LIMIT 5`, []),
    ]);

    const r = recharges.rows[0];
    const w2 = withdrawals.rows[0];
    const c = commissions.rows[0];
    const wl = wallets.rows[0];

    res.json({
      success: true,
      data: {
        period: { from: from || null, to: to || null },
        recharges:   { count: parseInt(r.count),  total: parseFloat(r.total) },
        withdrawals: { count: parseInt(w2.count), total: parseFloat(w2.total) },
        commissions: {
          ordersCount:       parseInt(c.orders_count),
          totalCommission:   parseFloat(c.total_commission),
          totalVisitRevenue: parseFloat(c.total_visit_revenue),
          totalWorkVolume:   parseFloat(c.total_work_volume),
        },
        wallets: {
          totalClientBalance:      parseFloat(wl.total_client_balance),
          totalBlocked:            parseFloat(wl.total_blocked),
          totalEarnedProviders:    parseFloat(wl.total_earned_providers),
          totalWithdrawnProviders: parseFloat(wl.total_withdrawn_providers),
        },
        byRole: byRole.rows.reduce((acc, row) => {
          acc[row.role] = { balance: parseFloat(row.balance), blocked: parseFloat(row.blocked), count: parseInt(row.count) };
          return acc;
        }, {}),
        txSummary: txSummary.rows,
        topProviders: topProviders.rows.map(p => ({
          fullName:        p.full_name,
          email:           p.email,
          totalEarned:     parseFloat(p.total_earned),
          totalWithdrawn:  parseFloat(p.total_withdrawn),
          currentBalance:  parseFloat(p.current_balance),
          ordersCompleted: parseInt(p.orders_completed),
        })),
      },
    });
  } catch (err) {
    console.error('finance error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;


// ════════════════════════════════════════════════════════════════
// ZONAS — solo admin
// ════════════════════════════════════════════════════════════════

router.get('/zones', adminAuth(['admin', 'moderator']), async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT z.*,
        COUNT(u.id) FILTER (WHERE u.zone_id = z.id) AS user_count
      FROM zones z
      LEFT JOIN users u ON u.zone_id = z.id
      GROUP BY z.id
      ORDER BY z.sort_order, z.name
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/zones', adminAuth(['admin']), async (req, res) => {
  try {
    const { name, slug, state = 'Zulia', latCenter, lngCenter, radiusKm = 15, sortOrder = 0 } = req.body;
    if (!name || !slug || !latCenter || !lngCenter)
      return res.status(400).json({ success: false, message: 'name, slug, latCenter y lngCenter son requeridos' });

    const { rows: [zone] } = await query(`
      INSERT INTO zones (name, slug, state, lat_center, lng_center, radius_km, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [name, slug, state, latCenter, lngCenter, radiusKm, sortOrder]);

    res.status(201).json({ success: true, data: zone });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'Ya existe una zona con ese slug' });
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/zones/:id', adminAuth(['admin']), async (req, res) => {
  try {
    const { name, state, latCenter, lngCenter, radiusKm, isActive, sortOrder } = req.body;
    await query(`
      UPDATE zones SET
        name       = COALESCE($1, name),
        state      = COALESCE($2, state),
        lat_center = COALESCE($3, lat_center),
        lng_center = COALESCE($4, lng_center),
        radius_km  = COALESCE($5, radius_km),
        is_active  = COALESCE($6, is_active),
        sort_order = COALESCE($7, sort_order)
      WHERE id = $8
    `, [name??null, state??null, latCenter??null, lngCenter??null,
        radiusKm??null, isActive??null, sortOrder??null, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});