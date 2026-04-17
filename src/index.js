require('dotenv').config();
const express     = require('express');
const http        = require('http');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');

require('./config/db');

const { initSocket }  = require('./config/socket');
const { initJobs }    = require('./jobs');

const authRoutes         = require('./routes/auth.routes');
const userRoutes         = require('./routes/user.routes');
const providerRoutes     = require('./routes/provider.routes');
const orderRoutes        = require('./routes/order.routes');
const walletRoutes       = require('./routes/wallet.routes');
const categoryRoutes     = require('./routes/category.routes');
const messageRoutes      = require('./routes/message.routes');
const notificationRoutes = require('./routes/notification.routes');
const adminRoutes        = require('./routes/admin.routes');
const kycRoutes          = require('./routes/kyc.routes');
const uploadRoutes       = require('./routes/upload.routes');

const app    = express();
const server = http.createServer(app);

initSocket(server);

app.use(helmet());
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── CORS ──────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean); // elimina entradas vacías

app.use(cors({
  origin: (origin, callback) => {
    // Sin origin: apps móviles, Postman, curl → permitir siempre
    if (!origin) return callback(null, true);
    // Lista vacía (sin .env) → permitir todo (solo desarrollo)
    if (allowedOrigins.length === 0) return callback(null, true);
    // Origin en lista → permitir
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Bloqueado
    console.warn(`🚫 CORS bloqueado: ${origin}`);
    callback(new Error(`CORS bloqueado: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Responder preflight OPTIONS antes de cualquier ruta
app.options('*', cors());

// ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/health', (req, res) => res.json({
  status: 'ok', app: 'Hacelo API', version: '1.0.0',
  timestamp: new Date().toISOString(),
}));

const API = '/api/v1';
app.use(`${API}/auth`,          authRoutes);
app.use(`${API}/users`,         userRoutes);
app.use(`${API}/providers`,     providerRoutes);
app.use(`${API}/orders`,        orderRoutes);
app.use(`${API}/wallet`,        walletRoutes);
app.use(`${API}/categories`,    categoryRoutes);
app.use(`${API}/messages`,      messageRoutes);
app.use(`${API}/notifications`, notificationRoutes);
app.use(`${API}/admin`,         adminRoutes);
app.use(`${API}/kyc`,           kycRoutes);
app.use(`${API}/upload`,        uploadRoutes);

app.use('*', (req, res) => res.status(404).json({
  success: false,
  message: `Ruta no encontrada: ${req.method} ${req.originalUrl}`,
}));

app.use((err, req, res, next) => res.status(err.status || 500).json({
  success: false,
  message: process.env.NODE_ENV === 'production' ? 'Error interno' : err.message,
}));

const PORT       = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || 'localhost';

server.listen(PORT, () => {
  console.log(`\n🚀 Hacelo API en puerto ${PORT}`);
  console.log(`🔗 Health: http://${SERVER_URL}:${PORT}/health\n`);
  initJobs();
});

module.exports = { app, server };