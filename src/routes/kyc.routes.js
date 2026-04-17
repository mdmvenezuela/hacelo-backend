const express = require('express');
const { query, transaction } = require('../config/db');
const { authenticate, requireAdmin } = require('../middlewares/auth.middleware');

const router = express.Router();

// ── POST /kyc/submit — Proveedor envía documentos KYC ────────
router.post('/submit', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      selfieUrl,
      cedulaFrontUrl, idFrontUrl,    // acepta ambos nombres
      cedulaBackUrl,  idBackUrl,
      rifUrl,
      videoUrl, videoSelfieUrl,       // acepta ambos nombres
    } = req.body;

    // Normalizar nombres de campos
    const front = cedulaFrontUrl || idFrontUrl;
    const back  = cedulaBackUrl  || idBackUrl;
    const video = videoUrl       || videoSelfieUrl;

    // Solo los campos realmente obligatorios
    const missing = [];
    if (!selfieUrl) missing.push('Selfie con cédula');
    if (!front)     missing.push('Cédula (frente)');
    if (!back)      missing.push('Cédula (dorso)');
    if (!video)     missing.push('Video selfie');

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Faltan documentos obligatorios: ${missing.join(', ')}`,
      });
    }

    // Verificar si ya fue aprobado
    const { rows: [existing] } = await query(
      'SELECT id, status FROM provider_kyc WHERE user_id = $1', [userId]
    );

    if (existing?.status === 'approved') {
      return res.status(400).json({ success: false, message: 'Tu identidad ya fue verificada.' });
    }
    if (existing?.status === 'under_review') {
      return res.status(400).json({ success: false, message: 'Tu verificación está en revisión. Espera la respuesta.' });
    }

    if (existing) {
      await query(`
        UPDATE provider_kyc SET
          selfie_url = $1, id_front_url = $2, id_back_url = $3,
          rif_url = $4, video_selfie_url = $5,
          status = 'pending', submitted_at = NOW(), updated_at = NOW()
        WHERE user_id = $6
      `, [selfieUrl, front, back, rifUrl || null, video, userId]);
    } else {
      await query(`
        INSERT INTO provider_kyc
          (user_id, selfie_url, id_front_url, id_back_url, rif_url, video_selfie_url)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [userId, selfieUrl, front, back, rifUrl || null, video]);
    }

    await query(
      `UPDATE provider_profiles SET kyc_status = 'pending', kyc_submitted_at = NOW() WHERE user_id = $1`,
      [userId]
    );

    res.json({
      success: true,
      message: 'Documentos enviados correctamente. El equipo de Hacelo los revisará en 24-48 horas hábiles.',
    });
  } catch (err) {
    console.error('kyc submit error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /kyc/status — Estado actual del KYC ──────────────────
router.get('/status', authenticate, async (req, res) => {
  try {
    const { rows: [kyc] } = await query(
      `SELECT status, rejection_reason, submitted_at, reviewed_at FROM provider_kyc WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({ success: true, data: kyc || { status: 'not_submitted' } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /kyc/pending — Admin: lista KYC pendientes ───────────
router.get('/pending', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT k.*, u.full_name, u.email
      FROM provider_kyc k
      JOIN users u ON u.id = k.user_id
      WHERE k.status IN ('pending', 'under_review')
      ORDER BY k.submitted_at ASC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /kyc/:userId/approve — Admin aprueba KYC ───────────
router.patch('/:userId/approve', authenticate, requireAdmin, async (req, res) => {
  try {
    await transaction(async (client) => {
      await client.query(`
        UPDATE provider_kyc
        SET status = 'approved', reviewed_at = NOW(), reviewed_by = $1
        WHERE user_id = $2
      `, [req.user.id, req.params.userId]);

      await client.query(`
        UPDATE provider_profiles
        SET kyc_status = 'approved', is_verified = true
        WHERE user_id = $1
      `, [req.params.userId]);

      await client.query(
        `UPDATE users SET is_verified = true WHERE id = $1`,
        [req.params.userId]
      );
    });

    res.json({ success: true, message: 'KYC aprobado. El proveedor ya puede publicar servicios.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /kyc/:userId/reject — Admin rechaza KYC ────────────
router.patch('/:userId/reject', authenticate, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Debes indicar el motivo del rechazo' });

    await query(`
      UPDATE provider_kyc
      SET status = 'rejected', rejection_reason = $1,
          reviewed_at = NOW(), reviewed_by = $2
      WHERE user_id = $3
    `, [reason, req.user.id, req.params.userId]);

    await query(
      `UPDATE provider_profiles SET kyc_status = 'rejected' WHERE user_id = $1`,
      [req.params.userId]
    );

    res.json({ success: true, message: 'KYC rechazado.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;