const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

let io;
// userId → Set de socketIds
const userSockets = new Map();

const initSocket = (server) => {
  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // ── Middleware de autenticación ───────────────────────────
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('No token'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId;
      socket.userRole = decoded.role;
      next();
    } catch {
      next(new Error('Token inválido'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;

    // Registrar socket del usuario
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socket.id);

    console.log(`🔌 Usuario conectado: ${userId} (socket: ${socket.id})`);

    // ── Unirse a sala de orden para chat ────────────────────
    socket.on('join_order', (orderId) => {
      if (orderId) socket.join(`order:${orderId}`);
    });

    // Sala personal para recibir notificaciones de badge
    socket.on('join_user', (uid) => {
      if (uid === userId) socket.join(`user:${uid}`);
    });

    socket.on('leave_order', (orderId) => {
      if (orderId) socket.leave(`order:${orderId}`);
    });

    // ── Indicador de escritura ──────────────────────────────
    socket.on('typing_start', ({ orderId }) => {
      socket.to(`order:${orderId}`).emit('user_typing', { userId, orderId });
    });

    socket.on('typing_stop', ({ orderId }) => {
      socket.to(`order:${orderId}`).emit('user_stopped_typing', { userId, orderId });
    });

    // ── Desconexión ─────────────────────────────────────────
    socket.on('disconnect', () => {
      const sockets = userSockets.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) userSockets.delete(userId);
      }
      console.log(`🔌 Usuario desconectado: ${userId}`);
    });
  });

  console.log('⚡ Socket.io iniciado');
  return io;
};

// Emitir a todos los sockets de un usuario específico
const emitToUser = (userId, event, data) => {
  if (!io || !userId) return;
  const sockets = userSockets.get(userId);
  if (sockets && sockets.size > 0) {
    sockets.forEach(socketId => {
      io.to(socketId).emit(event, data);
    });
  }
};

// Emitir a toda la sala de una orden (chat)
const emitToOrder = (orderId, event, data) => {
  if (!io || !orderId) return;
  io.to(`order:${orderId}`).emit(event, data);
};

const getIO = () => io;

module.exports = { initSocket, emitToUser, emitToOrder, getIO };