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
          COUNT(*) FILTER (WHERE status = 'pending')    AS pending,
          COUNT(*) FILTER (WHERE status = 'processing') AS processing,
          SUM(amount) FILTER (WHERE status = 'pending') AS pending_amount
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
      "SELECT * FROM withdrawal_requests WHERE id = $1 AND status = 'pending'",
      [req.params.id]
    );
    if (!wr) return res.status(404).json({ success: false, message: 'Retiro no encontrado o ya procesado' });

    await transaction(async (client) => {
      const { rows: [wallet] } = await client.query(
        'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
        [wr.user_id]
      );

      const balanceBefore = parseFloat(wallet.balance);
      const amount        = parseFloat(wr.amount);

      if (balanceBefore < amount)
        throw new Error(`Saldo insuficiente. Disponible: $${balanceBefore.toFixed(2)}`);

      const balanceAfter = balanceBefore - amount;

      // Descontar saldo
      await client.query(
        'UPDATE wallets SET balance = $1, total_withdrawn = total_withdrawn + $2 WHERE user_id = $3',
        [balanceAfter, amount, wr.user_id]
      );

      // Registrar transacción
      await client.query(`
        INSERT INTO wallet_transactions
          (wallet_id, type, status, amount, balance_before, balance_after,
           reference_id, reference_type, description, metadata)
        VALUES ($1, 'withdrawal', 'approved', $2, $3, $4, $5, 'withdrawal_request', $6, $7)
      `, [
        wallet.id, amount, balanceBefore, balanceAfter, wr.id,
        `Retiro procesado por: ${req.admin.full_name}`,
        JSON.stringify({ admin_id: req.admin.id, admin_name: req.admin.full_name }),
      ]);

      // Marcar como completado
      await client.query(
        `UPDATE withdrawal_requests
         SET status = 'completed', processed_at = NOW(), processed_by = $1,
             admin_notes = $2
         WHERE id = $3`,
        [req.admin.id, `Procesado por: ${req.admin.full_name}`, wr.id]
      );
    });

    // Notificar al proveedor
    push.sendPushToUser(wr.user_id, {
      title: '💵 Retiro procesado',
      body:  `Tu retiro de $${parseFloat(wr.amount).toFixed(2)} fue procesado exitosamente.`,
      data:  { screen: 'wallet' },
    }).catch(() => {});

    res.json({ success: true, message: 'Retiro aprobado y saldo descontado' });
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
      "SELECT * FROM withdrawal_requests WHERE id = $1 AND status = 'pending'",
      [req.params.id]
    );
    if (!wr) return res.status(404).json({ success: false, message: 'Retiro no encontrado o ya procesado' });

    await query(
      `UPDATE withdrawal_requests
       SET status = 'rejected', processed_at = NOW(),
           processed_by = $1, admin_notes = $2
       WHERE id = $3`,
      [req.admin.id, reason, wr.id]
    );

    push.sendPushToUser(wr.user_id, {
      title: '❌ Retiro rechazado',
      body:  reason,
      data:  { screen: 'wallet' },
    }).catch(() => {});

    res.json({ success: true, message: 'Retiro rechazado' });
  } catch (err) {
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
    const { name, type, currency = 'USD', instructions, fields = [], minAmount = 1, maxAmount = 1000, verificationTime = '1-4 horas', sortOrder = 0 } = req.body;
    if (!name || !type)
      return res.status(400).json({ success: false, message: 'name y type son requeridos' });

    const { rows: [pm] } = await query(`
      INSERT INTO payment_methods
        (name, type, currency, instructions, fields, min_amount, max_amount, verification_time, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [name, type, currency, instructions || null, JSON.stringify(fields), minAmount, maxAmount, verificationTime, sortOrder]);

    res.status(201).json({ success: true, data: pm });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/payment-methods/:id', adminAuth(['admin']), async (req, res) => {
  try {
    const { name, instructions, minAmount, maxAmount, verificationTime, isActive, sortOrder } = req.body;
    await query(`
      UPDATE payment_methods SET
        name              = COALESCE($1, name),
        instructions      = COALESCE($2, instructions),
        min_amount        = COALESCE($3, min_amount),
        max_amount        = COALESCE($4, max_amount),
        verification_time = COALESCE($5, verification_time),
        is_active         = COALESCE($6, is_active),
        sort_order        = COALESCE($7, sort_order),
        updated_at        = NOW()
      WHERE id = $8
    `, [name ?? null, instructions ?? null, minAmount ?? null, maxAmount ?? null,
        verificationTime ?? null, isActive ?? null, sortOrder ?? null, req.params.id]);

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

module.exports = router;