// src/routes/zones.routes.js
const express = require('express');
const { query } = require('../config/db');
const { authenticate } = require('../middlewares/auth.middleware');

const router = express.Router();

// ── Función Haversine — distancia entre dos coordenadas ──────
const haversineKm = (lat1, lng1, lat2, lng2) => {
  const R  = 6371;
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dG = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(dL/2)**2 +
             Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dG/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};

// ── GET /zones — Lista zonas activas ─────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM zones WHERE is_active = true ORDER BY sort_order, name'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /zones/detect — Detectar zona por GPS ───────────────
// Body: { latitude, longitude }
// Retorna la zona más cercana dentro del radio
router.post('/detect', async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    if (!latitude || !longitude) {
      return res.status(400).json({ success: false, message: 'latitude y longitude requeridos' });
    }

    const { rows: zones } = await query(
      'SELECT * FROM zones WHERE is_active = true ORDER BY sort_order'
    );

    let closest = null;
    let minDist = Infinity;

    for (const zone of zones) {
      const dist = haversineKm(
        parseFloat(latitude), parseFloat(longitude),
        parseFloat(zone.lat_center), parseFloat(zone.lng_center)
      );
      if (dist < minDist) {
        minDist = dist;
        closest = { ...zone, distance_km: parseFloat(dist.toFixed(2)) };
      }
    }

    if (!closest) {
      return res.status(404).json({ success: false, message: 'No se encontró ninguna zona activa' });
    }

    // Informar si está dentro o fuera del radio
    const insideZone = minDist <= parseFloat(closest.radius_km);

    res.json({
      success: true,
      data: closest,
      insideZone,
      message: insideZone
        ? `Zona detectada: ${closest.name}`
        : `Zona más cercana: ${closest.name} (${closest.distance_km}km — fuera del área de cobertura)`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /zones/me — El usuario elige su zona ───────────────
router.patch('/me', authenticate, async (req, res) => {
  try {
    const { zoneId } = req.body;
    if (!zoneId) return res.status(400).json({ success: false, message: 'zoneId requerido' });

    const { rows: [zone] } = await query(
      'SELECT id, name FROM zones WHERE id = $1 AND is_active = true', [zoneId]
    );
    if (!zone) return res.status(404).json({ success: false, message: 'Zona no encontrada o inactiva' });

    await query('UPDATE users SET zone_id = $1 WHERE id = $2', [zoneId, req.user.id]);

    res.json({ success: true, data: zone, message: `Zona actualizada: ${zone.name}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

// ── GET /zones/:zoneId/sectors — Sectores de una zona ────────
router.get('/:zoneId/sectors', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM sectors
       WHERE zone_id = $1 AND is_active = true
       ORDER BY sort_order, name`,
      [req.params.zoneId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /zones/sectors/all — Todos los sectores del usuario ──
// Útil para cargar sectores de la zona del usuario logueado
router.get('/sectors/by-zone/:zoneId', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT s.*, z.name AS zone_name
       FROM sectors s
       JOIN zones z ON z.id = s.zone_id
       WHERE s.zone_id = $1 AND s.is_active = true
       ORDER BY s.sort_order, s.name`,
      [req.params.zoneId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});