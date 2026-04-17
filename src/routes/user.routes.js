// ── user.routes.js ──────────────────────────────────────────
const express = require('express');
const { authenticate } = require('../middlewares/auth.middleware');
const { query } = require('../config/db');

const userRouter = express.Router();

userRouter.get('/me', authenticate, async (req, res) => {
  const { rows: [user] } = await query(
    `SELECT u.id, u.email, u.full_name, u.avatar_url, u.role, u.phone, u.phone_verified,
            w.balance, w.blocked_balance
     FROM users u
     LEFT JOIN wallets w ON w.user_id = u.id
     WHERE u.id = $1`,
    [req.user.id]
  );
  res.json({ success: true, data: user });
});

userRouter.patch('/me', authenticate, async (req, res) => {
  const { fullName, phone, avatarUrl } = req.body;
  await query(
    'UPDATE users SET full_name = COALESCE($1, full_name), phone = COALESCE($2, phone), avatar_url = COALESCE($3, avatar_url) WHERE id = $4',
    [fullName, phone, avatarUrl, req.user.id]
  );
  res.json({ success: true, message: 'Perfil actualizado' });
});

module.exports = userRouter;