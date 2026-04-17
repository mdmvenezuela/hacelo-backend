const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { query, transaction } = require('../../config/db');
const WalletService = require('../../services/wallet.service');

const generateTokens = (userId, role) => {
  const access = jwt.sign(
    { userId, role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
  const refresh = jwt.sign(
    { userId, role },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
  );
  return { access, refresh };
};

// ── POST /auth/register ──────────────────────────────────────
const register = async (req, res) => {
  try {
    const { email, fullName, password, role = 'client', phone } = req.body;

    // Verificar si ya existe
    const { rows: existing } = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.length) {
      return res.status(409).json({ success: false, message: 'Este correo ya está registrado' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await transaction(async (client) => {
      // Crear usuario
      const { rows: [newUser] } = await client.query(`
        INSERT INTO users (email, full_name, password_hash, role, phone)
VALUES ($1, $2, $3, $4, $5) RETURNING *
      `, [email, fullName, passwordHash, role, phone || null]);

      // Crear perfil según rol
      if (role === 'client') {
        await client.query(
          'INSERT INTO client_profiles (user_id) VALUES ($1)',
          [newUser.id]
        );
      } else if (role === 'provider') {
        await client.query(
          'INSERT INTO provider_profiles (user_id) VALUES ($1)',
          [newUser.id]
        );
      }

      // Crear wallet
      await client.query(
        'INSERT INTO wallets (user_id) VALUES ($1)',
        [newUser.id]
      );

      return newUser;
    });

    const tokens = generateTokens(user.id, user.role);

    res.status(201).json({
      success: true,
      message: 'Registro exitoso',
      data: {
        user: {
          id: user.id, email: user.email,
          fullName: user.full_name, role: user.role,
        },
        tokens,
      },
    });

  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /auth/login ─────────────────────────────────────────
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const { rows: [user] } = await query(
      'SELECT * FROM users WHERE email = $1 AND is_active = true',
      [email]
    );

    if (!user) {
      return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
    }

    // Si tiene firebase_uid no tiene password_hash local
    if (user.firebase_uid && !user.password_hash) {
      return res.status(401).json({
        success: false,
        message: 'Esta cuenta usa Google o Apple. Inicia sesión con ese método.',
      });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
    }

    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    // Obtener wallet
    const { rows: [wallet] } = await query(
      'SELECT balance, blocked_balance FROM wallets WHERE user_id = $1',
      [user.id]
    );

    const tokens = generateTokens(user.id, user.role);

    res.json({
      success: true,
      data: {
        user: {
          id: user.id, email: user.email,
          fullName: user.full_name, role: user.role,
          avatarUrl: user.avatar_url,
        },
        wallet,
        tokens,
      },
    });

  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /auth/firebase — Login con Firebase (Google/Apple) ──
const firebaseLogin = async (req, res) => {
  try {
    const { firebaseToken, role = 'client' } = req.body;

    // Verificar token de Firebase
    const admin = require('firebase-admin');
    const decoded = await admin.auth().verifyIdToken(firebaseToken);

    const { uid, email, name, picture } = decoded;

    // Buscar o crear usuario
    let { rows: [user] } = await query(
      'SELECT * FROM users WHERE firebase_uid = $1 OR email = $2',
      [uid, email]
    );

    if (!user) {
      user = await transaction(async (client) => {
        const { rows: [newUser] } = await client.query(`
          INSERT INTO users (firebase_uid, email, full_name, avatar_url, role, phone_verified)
          VALUES ($1, $2, $3, $4, $5, false) RETURNING *
        `, [uid, email, name || email.split('@')[0], picture || null, role]);

        if (role === 'client') {
          await client.query('INSERT INTO client_profiles (user_id) VALUES ($1)', [newUser.id]);
        } else if (role === 'provider') {
          await client.query('INSERT INTO provider_profiles (user_id) VALUES ($1)', [newUser.id]);
        }

        await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [newUser.id]);

        return newUser;
      });
    } else {
      // Actualizar firebase_uid si no lo tenía
      if (!user.firebase_uid) {
        await query('UPDATE users SET firebase_uid = $1 WHERE id = $2', [uid, user.id]);
      }
      await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    }

    const { rows: [wallet] } = await query(
      'SELECT balance, blocked_balance FROM wallets WHERE user_id = $1',
      [user.id]
    );

    const tokens = generateTokens(user.id, user.role);

    res.json({
      success: true,
      data: {
        user: {
          id: user.id, email: user.email,
          fullName: user.full_name, role: user.role,
          avatarUrl: user.avatar_url,
        },
        wallet,
        tokens,
      },
    });

  } catch (err) {
    console.error('firebaseLogin error:', err);
    res.status(500).json({ success: false, message: 'Error de autenticación con Firebase' });
  }
};

// ── POST /auth/refresh ───────────────────────────────────────
const refreshToken = async (req, res) => {
  try {
    const { refreshToken: token } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'Refresh token requerido' });

    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const tokens  = generateTokens(payload.userId, payload.role);

    res.json({ success: true, data: { tokens } });

  } catch (err) {
    res.status(401).json({ success: false, message: 'Refresh token inválido o expirado' });
  }
};

module.exports = { register, login, firebaseLogin, refreshToken };