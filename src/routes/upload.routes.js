const express  = require('express');
const multer   = require('multer');
const cloudinary = require('cloudinary').v2;
const { authenticate } = require('../middlewares/auth.middleware');

const router = express.Router();

// Configurar Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer en memoria
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Solo se permiten imágenes y videos'));
  },
});

// POST /upload — sube un archivo y devuelve la URL de Cloudinary
router.post('/', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No se recibió archivo' });

    const folder = req.body.folder || 'hacelo/general';

    // Si Cloudinary no está configurado, devolver URL de placeholder
    if (!process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_CLOUD_NAME === 'tu_cloud_name') {
      return res.json({
        success: true,
        data: {
          url: `https://ui-avatars.com/api/?name=${req.user.id}&background=FF6B2C&color=fff&size=200`,
          publicId: 'placeholder',
        },
      });
    }

    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: `hacelo/${folder}`, resource_type: 'auto', quality: 'auto' },
        (error, result) => error ? reject(error) : resolve(result)
      ).end(req.file.buffer);
    });

    res.json({ success: true, data: { url: result.secure_url, publicId: result.public_id } });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;