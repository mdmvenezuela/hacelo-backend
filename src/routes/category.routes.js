// category.routes.js
const express = require('express');
const { query } = require('../config/db');
const { authenticate, requireAdmin } = require('../middlewares/auth.middleware');

const categoryRouter = express.Router();

categoryRouter.get('/', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM categories WHERE is_active = true ORDER BY sort_order',
  );
  res.json({ success: true, data: rows });
});

categoryRouter.post('/', authenticate, requireAdmin, async (req, res) => {
  const { name, slug, icon, color, description } = req.body;
  const { rows: [cat] } = await query(
    'INSERT INTO categories (name, slug, icon, color, description) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [name, slug, icon, color, description]
  );
  res.status(201).json({ success: true, data: cat });
});

module.exports = categoryRouter;