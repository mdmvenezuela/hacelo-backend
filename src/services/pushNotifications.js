// ══════════════════════════════════════════════════════════════
// src/services/pushNotifications.js
// Servicio de notificaciones push con Expo
// ══════════════════════════════════════════════════════════════

const { query } = require('../config/db');

// ── Enviar notificación a un usuario ─────────────────────────
const sendPushToUser = async (userId, { title, body, data = {} }) => {
  try {
    // Obtener token del usuario
    const { rows } = await query(
      'SELECT push_token FROM users WHERE id = $1 AND push_token IS NOT NULL',
      [userId]
    );

    if (!rows.length || !rows[0].push_token) return;

    const token = rows[0].push_token;

    // Solo enviar si es un token Expo válido
    if (!token.startsWith('ExponentPushToken[') && !token.startsWith('ExpoPushToken[')) {
      return;
    }

    const message = {
      to: token,
      sound: 'default',
      title,
      body,
      data,
      priority: 'high',
      channelId: 'default',
    };

    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    const result = await response.json();

    if (result.data?.status === 'error') {
      console.error(`❌ Push error para usuario ${userId}:`, result.data.message);

      // Si el token es inválido, borrarlo
      if (result.data.details?.error === 'DeviceNotRegistered') {
        await query('UPDATE users SET push_token = NULL WHERE id = $1', [userId]);
      }
    }
  } catch (err) {
    console.error('❌ Error enviando push:', err.message);
  }
};

// ── Enviar a múltiples usuarios ───────────────────────────────
const sendPushToMany = async (userIds, notification) => {
  await Promise.allSettled(
    userIds.map(id => sendPushToUser(id, notification))
  );
};

// ════════════════════════════════════════════════════════════════
// NOTIFICACIONES POR EVENTO
// ════════════════════════════════════════════════════════════════

// ── Orden: nueva solicitud (para el proveedor) ────────────────
const notifyNewOrder = async (providerId, order) => {
  await sendPushToUser(providerId, {
    title: '📋 Nueva solicitud',
    body: `${order.clientName} necesita un ${order.categoryName}`,
    data: { screen: 'order', orderId: order.id },
  });
};

// ── Orden: aceptada (para el cliente) ────────────────────────
const notifyOrderAccepted = async (clientId, order) => {
  await sendPushToUser(clientId, {
    title: '✅ Solicitud aceptada',
    body: `${order.providerName} aceptó tu solicitud y está en camino`,
    data: { screen: 'order', orderId: order.id },
  });
};

// ── Orden: rechazada (para el cliente) ───────────────────────
const notifyOrderRejected = async (clientId, order) => {
  await sendPushToUser(clientId, {
    title: '❌ Solicitud rechazada',
    body: `${order.providerName} no pudo atenderte. Tu saldo fue desbloqueado.`,
    data: { screen: 'order', orderId: order.id },
  });
};

// ── Orden: proveedor en camino (para el cliente) ─────────────
const notifyProviderOnTheWay = async (clientId, order) => {
  await sendPushToUser(clientId, {
    title: '🚗 El técnico está en camino',
    body: `${order.providerName} está yendo hacia tu ubicación`,
    data: { screen: 'order', orderId: order.id },
  });
};

// ── Orden: proveedor llegó — se cobra visita ─────────────────
const notifyProviderArrived = async (clientId, order) => {
  await sendPushToUser(clientId, {
    title: '📍 El técnico llegó',
    body: `Se cobraron $${order.visitPrice} de tu wallet por la visita`,
    data: { screen: 'order', orderId: order.id },
  });
};

// ── Presupuesto enviado (para el cliente) ────────────────────
const notifyQuoteSent = async (clientId, order) => {
  await sendPushToUser(clientId, {
    title: '💰 Presupuesto recibido',
    body: `${order.providerName} envió un presupuesto de $${order.workTotal}. Revísalo.`,
    data: { screen: 'order', orderId: order.id },
  });
};

// ── Cliente aceptó presupuesto (para el proveedor) ───────────
const notifyQuoteAccepted = async (providerId, order) => {
  await sendPushToUser(providerId, {
    title: '✅ Presupuesto aceptado',
    body: `El cliente aceptó el presupuesto de $${order.workTotal}. ¡A trabajar!`,
    data: { screen: 'order', orderId: order.id },
  });
};

// ── Cliente rechazó presupuesto (para el proveedor) ──────────
const notifyQuoteRejected = async (providerId, order) => {
  await sendPushToUser(providerId, {
    title: '❌ Presupuesto rechazado',
    body: 'El cliente rechazó el presupuesto.',
    data: { screen: 'order', orderId: order.id },
  });
};

// ── Trabajo completado (para el cliente) ─────────────────────
const notifyWorkCompleted = async (clientId, order) => {
  await sendPushToUser(clientId, {
    title: '🔧 Trabajo terminado',
    body: `${order.providerName} marcó el trabajo como completado. ¿Quedó bien?`,
    data: { screen: 'order', orderId: order.id },
  });
};

// ── Pago liberado al proveedor ────────────────────────────────
const notifyPaymentReleased = async (providerId, order) => {
  await sendPushToUser(providerId, {
    title: '💵 ¡Pago recibido!',
    body: `$${order.netEarned} fueron acreditados a tu wallet`,
    data: { screen: 'wallet' },
  });
};

// ── Orden expirada (para el cliente) ─────────────────────────
const notifyOrderExpired = async (clientId, order) => {
  await sendPushToUser(clientId, {
    title: '⏰ Solicitud expirada',
    body: `El proveedor no respondió. Tu saldo de $${order.visitPrice} fue desbloqueado.`,
    data: { screen: 'orders' },
  });
};

// ── Orden auto-confirmada (para el proveedor) ────────────────
const notifyOrderAutoConfirmed = async (providerId, order) => {
  await sendPushToUser(providerId, {
    title: '✅ Pago liberado automáticamente',
    body: `El cliente no respondió en 48h. $${order.netEarned} acreditados a tu wallet.`,
    data: { screen: 'wallet' },
  });
};

// ── Nuevo mensaje en chat ─────────────────────────────────────
const notifyNewMessage = async (recipientId, { senderName, orderId, preview }) => {
  await sendPushToUser(recipientId, {
    title: `💬 ${senderName}`,
    body: preview.length > 60 ? preview.slice(0, 60) + '...' : preview,
    data: { screen: 'chat', orderId },
  });
};

// ── Recarga aprobada (para el cliente) ───────────────────────
const notifyRechargeApproved = async (userId, amount) => {
  await sendPushToUser(userId, {
    title: '💰 Recarga aprobada',
    body: `$${parseFloat(amount).toFixed(2)} fueron acreditados a tu wallet`,
    data: { screen: 'wallet' },
  });
};

// ── Recarga rechazada (para el cliente) ──────────────────────
const notifyRechargeRejected = async (userId, reason) => {
  await sendPushToUser(userId, {
    title: '❌ Recarga rechazada',
    body: reason || 'Tu recarga no fue aprobada. Contacta soporte.',
    data: { screen: 'wallet' },
  });
};

// ── KYC aprobado (para el proveedor) ─────────────────────────
const notifyKYCApproved = async (userId) => {
  await sendPushToUser(userId, {
    title: '🎉 ¡Verificación aprobada!',
    body: 'Tu cuenta fue verificada. Ya puedes recibir solicitudes de clientes.',
    data: { screen: 'home' },
  });
};

// ── KYC rechazado (para el proveedor) ────────────────────────
const notifyKYCRejected = async (userId, reason) => {
  await sendPushToUser(userId, {
    title: '❌ Verificación rechazada',
    body: reason || 'Tus documentos no fueron aprobados. Revisa el motivo en la app.',
    data: { screen: 'kyc' },
  });
};

module.exports = {
  sendPushToUser,
  sendPushToMany,
  notifyNewOrder,
  notifyOrderAccepted,
  notifyOrderRejected,
  notifyProviderOnTheWay,
  notifyProviderArrived,
  notifyQuoteSent,
  notifyQuoteAccepted,
  notifyQuoteRejected,
  notifyWorkCompleted,
  notifyPaymentReleased,
  notifyOrderExpired,
  notifyOrderAutoConfirmed,
  notifyNewMessage,
  notifyRechargeApproved,
  notifyRechargeRejected,
  notifyKYCApproved,
  notifyKYCRejected,
};