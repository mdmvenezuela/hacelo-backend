// ══════════════════════════════════════════════════════════════
// src/routes/admin.routes.js
// Panel web — autenticación y endpoints por rol
// ══════════════════════════════════════════════════════════════
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { query } = require('../config/db');
const push    = require('../services/pushNotifications');

const router = express.Router();

const ADMIN_SECRET = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET + '_admin';

// ── Middleware: autenticar admin ──────────────────────────────
const adminAuth = (allowedRoles = ['admin', 'moderator', 'conciliator']) => {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Sin autorización' });
      }
      const token = header.split(' ')[1];
      const payload = jwt.verify(token, ADMIN_SECRET);

      const { rows: [admin] } = await query(
        'SELECT id, email, full_name, role, is_active FROM admin_users WHERE id = $1',
        [payload.adminId]
      );

      if (!admin || !admin.is_active) {
        return res.status(401).json({ success: false, message: 'Administrador no válido' });
      }

      if (!allowedRoles.includes(admin.role)) {
        return res.status(403).json({ success: false, message: 'Sin permiso para esta acción' });
      }

      req.admin = admin;
      next();
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Token inválido' });
    }
  };
};

// ════════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════════

// POST /admin/auth/login
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email y contraseña requeridos' });
    }

    const { rows: [admin] } = await query(
      'SELECT * FROM admin_users WHERE email = $1 AND is_active = true',
      [email.toLowerCase()]
    );

    if (!admin) return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });

    // Actualizar last_login
    await query('UPDATE admin_users SET last_login=NOW() WHERE id=$1', [admin.id]);

    const token = jwt.sign(
      { adminId: admin.id, role: admin.role },
      ADMIN_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      success: true,
      data: {
        token,
        admin: {
          id:       admin.id,
          email:    admin.email,
          fullName: admin.full_name,
          role:     admin.role,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /admin/auth/me
router.get('/auth/me', adminAuth(), async (req, res) => {
  res.json({ success: true, data: req.admin });
});

// ════════════════════════════════════════════════════════════════
// DASHBOARD — solo admin y moderador
// ════════════════════════════════════════════════════════════════

router.get('/dashboard', adminAuth(['admin', 'moderator']), async (req, res) => {
  try {
    const [users, orders, recharges, wallet] = await Promise.all([
      query(`SELECT
        COUNT(*) FILTER (WHERE role='client')   AS clients,
        COUNT(*) FILTER (WHERE role='provider') AS providers,
        COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '7 days') AS new_this_week
        FROM users WHERE role != 'admin'`),
      query(`SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status='requested')  AS pending,
        COUNT(*) FILTER (WHERE status='in_progress') AS in_progress,
        COUNT(*) FILTER (WHERE status='completed')  AS completed,
        COUNT(*) FILTER (WHERE status='confirmed')  AS confirmed,
        COUNT(*) FILTER (WHERE status='cancelled')  AS cancelled,
        COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '7 days') AS this_week
        FROM orders`),
      query(`SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status='pending')  AS pending,
        COUNT(*) FILTER (WHERE status='approved') AS approved,
        SUM(amount) FILTER (WHERE status='approved') AS total_approved_amount
        FROM wallet_recharges`),
      query(`SELECT
        SUM(balance) AS total_balance,
        SUM(blocked_balance) AS total_blocked
        FROM wallets`),
    ]);

    res.json({
      success: true,
      data: {
        users:    users.rows[0],
        orders:   orders.rows[0],
        recharges: recharges.rows[0],
        wallet:   wallet.rows[0],
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// USUARIOS — admin y moderador
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

    const { rows } = await query(`
      SELECT
        u.id, u.email, u.full_name, u.phone, u.role,
        u.is_active, u.is_verified, u.avatar_url, u.created_at,
        w.balance, w.blocked_balance,
        pp.kyc_status, pp.rating_avg, pp.orders_completed
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.id
      LEFT JOIN provider_profiles pp ON pp.user_id = u.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY u.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    const { rows: [{ count }] } = await query(
      `SELECT COUNT(*) FROM users u WHERE ${conditions.join(' AND ')}`,
      params
    );

    res.json({ success: true, data: rows, total: parseInt(count) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /admin/users/:id — activar/desactivar
router.patch('/users/:id', adminAuth(['admin', 'moderator']), async (req, res) => {
  try {
    const { isActive } = req.body;
    await query('UPDATE users SET is_active=$1 WHERE id=$2', [isActive, req.params.id]);
    res.json({ success: true, message: isActive ? 'Usuario activado' : 'Usuario desactivado' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// KYC — admin y moderador
// ════════════════════════════════════════════════════════════════

router.get('/kyc', adminAuth(['admin', 'moderator']), async (req, res) => {
  try {
    const { status = 'pending', page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const { rows } = await query(`
      SELECT
        k.id, k.user_id, k.status, k.submitted_at, k.reviewed_at,
        k.rejection_reason,
        k.selfie_url, k.id_front_url, k.id_back_url, k.rif_url, k.video_selfie_url,
        k.full_name_doc, k.id_number, k.rif_number,
        u.full_name, u.email, u.phone
      FROM kyc_submissions k
      JOIN users u ON u.id = k.user_id
      WHERE k.status = $1
      ORDER BY k.submitted_at ASC
      LIMIT $2 OFFSET $3
    `, [status, limit, offset]);

    const { rows: [{ count }] } = await query(
      'SELECT COUNT(*) FROM kyc_submissions WHERE status=$1', [status]
    );

    res.json({ success: true, data: rows, total: parseInt(count) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /admin/kyc/:id/approve
router.post('/kyc/:id/approve', adminAuth(['admin', 'moderator']), async (req, res) => {
  try {
    const { rows: [kyc] } = await query(
      "UPDATE kyc_submissions SET status='approved', reviewed_at=NOW(), reviewed_by=$1 WHERE id=$2 RETURNING *",
      [req.admin.id, req.params.id]
    );
    if (!kyc) return res.status(404).json({ success: false, message: 'KYC no encontrado' });

    await query(
      'UPDATE users SET is_verified=true WHERE id=$1',
      [kyc.user_id]
    );
    await query(
      "UPDATE provider_profiles SET is_verified=true, kyc_status='approved' WHERE user_id=$1",
      [kyc.user_id]
    );

    // 🔔 Push al proveedor
    await push.notifyKYCApproved(kyc.user_id);

    res.json({ success: true, message: 'KYC aprobado' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /admin/kyc/:id/reject
router.post('/kyc/:id/reject', adminAuth(['admin', 'moderator']), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Motivo requerido' });

    const { rows: [kyc] } = await query(
      "UPDATE kyc_submissions SET status='rejected', reviewed_at=NOW(), reviewed_by=$1, rejection_reason=$2 WHERE id=$3 RETURNING *",
      [req.admin.id, reason, req.params.id]
    );
    if (!kyc) return res.status(404).json({ success: false, message: 'KYC no encontrado' });

    await query(
      "UPDATE provider_profiles SET kyc_status='rejected' WHERE user_id=$1",
      [kyc.user_id]
    );

    // 🔔 Push al proveedor
    await push.notifyKYCRejected(kyc.user_id, reason);

    res.json({ success: true, message: 'KYC rechazado' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// ÓRDENES — admin y moderador
// ════════════════════════════════════════════════════════════════

router.get('/orders', adminAuth(['admin', 'moderator']), async (req, res) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];

    if (status) {
      params.push(status);
      conditions.push(`o.status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(c.full_name ILIKE $${params.length} OR p.full_name ILIKE $${params.length} OR o.title ILIKE $${params.length})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await query(`
      SELECT
        o.id, o.order_number, o.title, o.status, o.visit_price,
        o.work_total, o.is_urgent, o.created_at, o.confirmed_at,
        o.commission_amount,
        c.full_name AS client_name, c.email AS client_email,
        p.full_name AS provider_name,
        cat.name AS category_name
      FROM orders o
      JOIN users c ON c.id = o.client_id
      LEFT JOIN users p ON p.id = o.provider_id
      LEFT JOIN categories cat ON cat.id = o.category_id
      ${where}
      ORDER BY o.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    const { rows: [{ count }] } = await query(
      `SELECT COUNT(*) FROM orders o JOIN users c ON c.id=o.client_id LEFT JOIN users p ON p.id=o.provider_id ${where}`,
      params
    );

    res.json({ success: true, data: rows, total: parseInt(count) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// RECARGAS — todos los roles (conciliator solo tiene esto)
// ════════════════════════════════════════════════════════════════

router.get('/recharges', adminAuth(['admin', 'moderator', 'conciliator']), async (req, res) => {
  try {
    const { status = 'pending', page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const { rows } = await query(`
      SELECT
        r.id, r.user_id, r.amount, r.status, r.reference_number,
        r.payment_date, r.origin_bank, r.notes, r.created_at,
        r.reviewed_at, r.rejection_reason,
        u.full_name, u.email, u.phone,
        pm.name AS payment_method_name, pm.type AS payment_method_type
      FROM wallet_recharges r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN payment_methods pm ON pm.id = r.payment_method_id
      WHERE r.status = $1
      ORDER BY r.created_at ASC
      LIMIT $2 OFFSET $3
    `, [status, limit, offset]);

    const { rows: [{ count }] } = await query(
      'SELECT COUNT(*) FROM wallet_recharges WHERE status=$1', [status]
    );

    res.json({ success: true, data: rows, total: parseInt(count) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /admin/recharges/:id/approve
router.post('/recharges/:id/approve', adminAuth(['admin', 'moderator', 'conciliator']), async (req, res) => {
  try {
    const { rows: [recharge] } = await query(
      "SELECT * FROM wallet_recharges WHERE id=$1 AND status='pending'",
      [req.params.id]
    );
    if (!recharge) return res.status(404).json({ success: false, message: 'Recarga no encontrada' });

    // Acreditar saldo
    await query(
      'UPDATE wallets SET balance=balance+$1 WHERE user_id=$2',
      [recharge.amount, recharge.user_id]
    );

    await query(
      "UPDATE wallet_recharges SET status='approved', reviewed_at=NOW(), reviewed_by=$1 WHERE id=$2",
      [req.admin.id, recharge.id]
    );

    // 🔔 Push al usuario
    await push.notifyRechargeApproved(recharge.user_id, recharge.amount);

    res.json({ success: true, message: 'Recarga aprobada' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /admin/recharges/:id/reject
router.post('/recharges/:id/reject', adminAuth(['admin', 'moderator', 'conciliator']), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Motivo requerido' });

    const { rows: [recharge] } = await query(
      "SELECT * FROM wallet_recharges WHERE id=$1 AND status='pending'",
      [req.params.id]
    );
    if (!recharge) return res.status(404).json({ success: false, message: 'Recarga no encontrada' });

    await query(
      "UPDATE wallet_recharges SET status='rejected', reviewed_at=NOW(), reviewed_by=$1, rejection_reason=$2 WHERE id=$3",
      [req.admin.id, reason, recharge.id]
    );

    // 🔔 Push al usuario
    await push.notifyRechargeRejected(recharge.user_id, reason);

    res.json({ success: true, message: 'Recarga rechazada' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GESTIÓN DE ADMINS — solo admin
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
    if (!email || !password || !fullName || !role) {
      return res.status(400).json({ success: false, message: 'Todos los campos son requeridos' });
    }
    if (!['admin', 'moderator', 'conciliator'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Rol inválido' });
    }

    const hash = await bcrypt.hash(password, 12);
    const { rows: [admin] } = await query(
      'INSERT INTO admin_users (email, password_hash, full_name, role) VALUES ($1,$2,$3,$4) RETURNING id, email, full_name, role',
      [email.toLowerCase(), hash, fullName, role]
    );

    res.status(201).json({ success: true, data: admin });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'Ya existe un admin con ese email' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/admins/:id', adminAuth(['admin']), async (req, res) => {
  try {
    const { isActive, role } = req.body;
    await query(
      'UPDATE admin_users SET is_active=COALESCE($1,is_active), role=COALESCE($2,role) WHERE id=$3',
      [isActive, role, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;