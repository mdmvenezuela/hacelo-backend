const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

// ── Verificar token JWT ───────────────────────────────────────
const verifyToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET);
};

// ── Middleware: requiere autenticación ────────────────────────
const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Token no proporcionado' });
    }

    const token = header.split(' ')[1];
    const payload = verifyToken(token);

    // Verificar que el usuario siga activo en DB
    const { rows } = await query(
      'SELECT id, email, full_name, role, is_active FROM users WHERE id = $1',
      [payload.userId]
    );

    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ success: false, message: 'Usuario no encontrado o inactivo' });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expirado', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ success: false, message: 'Token inválido' });
  }
};

// ── Middleware: requiere rol específico ───────────────────────
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    return res.status(403).json({
      success: false,
      message: 'No tienes permiso para esta acción',
    });
  }
  next();
};

// Atajos de roles
const requireAdmin    = requireRole('admin');
const requireClient   = requireRole('client', 'admin');
const requireProvider = requireRole('provider', 'admin');
const requireAny      = requireRole('client', 'provider', 'admin');

module.exports = {
  verifyToken,
  authenticate,
  requireRole,
  requireAdmin,
  requireClient,
  requireProvider,
  requireAny,
};