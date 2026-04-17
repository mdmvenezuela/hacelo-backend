const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { query } = require('../config/db');
const { authenticate } = require('../middlewares/auth.middleware');

const router = express.Router();

// ── Generar tokens ────────────────────────────────────────────
const generateTokens = (userId, role) => {
  const access = jwt.sign(
    { userId, role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  const refresh = jwt.sign(
    { userId, role, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
  return { access, refresh };
};

// ── Construir objeto de usuario completo ──────────────────────
// IMPORTANTE: siempre incluye is_verified desde users Y desde provider_profiles
const buildUserObject = async (userId) => {
  const { rows: [user] } = await query(`
    SELECT
      u.id, u.email, u.full_name, u.phone, u.role,
      u.avatar_url, u.created_at,
      COALESCE(u.is_verified, false)  AS is_verified,
      pp.kyc_status,
      pp.visit_price,
      pp.rating_avg,
      pp.orders_completed,
      pp.points,
      pp.level,
      pp.bio,
      pp.city,
      COALESCE(pp.is_verified, false) AS provider_is_verified
    FROM users u
    LEFT JOIN provider_profiles pp ON pp.user_id = u.id
    WHERE u.id = $1
  `, [userId]);

  if (!user) return null;

  // is_verified = true si ANY de las dos columnas es true
  user.is_verified = user.is_verified === true || user.provider_is_verified === true;
  delete user.provider_is_verified;

  return user;
};

// ── POST /auth/register ───────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { email, password, fullName, phone, role = 'client' } = req.body;

    if (!email || !password || !fullName) {
      return res.status(400).json({ success: false, message: 'Email, contraseña y nombre son requeridos' });
    }

    const { rows: [existing] } = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ success: false, message: 'Ya existe una cuenta con ese email' });

    const hash = await bcrypt.hash(password, 12);
    const { rows: [user] } = await query(`
      INSERT INTO users (email, password_hash, full_name, phone, role, is_verified)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, role
    `, [email.toLowerCase(), hash, fullName, phone || null, role, role === 'client']);
    // Clientes se verifican automáticamente, proveedores necesitan KYC

    if (role === 'provider') {
      await query(`
        INSERT INTO provider_profiles (user_id, is_verified, kyc_status)
        VALUES ($1, false, 'not_submitted')
        ON CONFLICT (user_id) DO NOTHING
      `, [user.id]);
      await query(`
        INSERT INTO wallets (user_id, balance, blocked_balance)
        VALUES ($1, 0, 0)
        ON CONFLICT (user_id) DO NOTHING
      `, [user.id]);
    } else {
      await query(`
        INSERT INTO wallets (user_id, balance, blocked_balance)
        VALUES ($1, 0, 0)
        ON CONFLICT (user_id) DO NOTHING
      `, [user.id]);
    }

    const fullUser = await buildUserObject(user.id);
    const tokens   = generateTokens(user.id, role);

    res.status(201).json({ success: true, data: { user: fullUser, tokens } });
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /auth/login ──────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email y contraseña son requeridos' });
    }

    const { rows: [row] } = await query(
      'SELECT id, password_hash, role FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (!row) return res.status(401).json({ success: false, message: 'Email o contraseña incorrectos' });

    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) return res.status(401).json({ success: false, message: 'Email o contraseña incorrectos' });

    // Construir objeto completo con is_verified correcto
    const user   = await buildUserObject(row.id);
    const tokens = generateTokens(row.id, row.role);

    // Obtener wallet del usuario
    const { rows: [wallet] } = await query(
      'SELECT balance, blocked_balance FROM wallets WHERE user_id = $1',
      [row.id]
    );

    res.json({
      success: true,
      data: {
        user,
        tokens,
        wallet: wallet || { balance: 0, blocked_balance: 0 },
      },
    });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /auth/me — Obtener usuario actual ─────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await buildUserObject(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });

    const { rows: [wallet] } = await query(
      'SELECT balance, blocked_balance FROM wallets WHERE user_id = $1',
      [req.user.id]
    );

    res.json({
      success: true,
      data: {
        user,
        wallet: wallet || { balance: 0, blocked_balance: 0 },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /auth/refresh ────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ success: false, message: 'Token requerido' });

    const decoded = jwt.verify(
      refreshToken,
      process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET
    );

    const tokens = generateTokens(decoded.userId, decoded.role);
    res.json({ success: true, data: { tokens } });
  } catch {
    res.status(401).json({ success: false, message: 'Token inválido o expirado' });
  }
});

module.exports = router;