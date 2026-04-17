-- ══════════════════════════════════════════════════════════════
-- Migración 004: Messages table + wallet blocked_balance for escrow
-- ══════════════════════════════════════════════════════════════

-- ── Tabla de mensajes (si no existe) ─────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sender_id   UUID NOT NULL REFERENCES users(id),
  content     TEXT,
  type        VARCHAR(20) DEFAULT 'text',   -- text | image | file | system
  file_url    TEXT,
  is_read     BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_order ON messages(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);

-- ── Asegurar que wallets tiene blocked_balance ────────────────
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS blocked_balance NUMERIC(10,2) DEFAULT 0;

-- ── Verificar que el balance bloqueado del proveedor se actualiza
-- cuando hay órdenes en estado 'completed' (en escrow)
-- Esta vista ayuda a debuggear:
-- SELECT u.full_name, w.balance, w.blocked_balance,
--        COUNT(o.id) FILTER (WHERE o.status='completed') AS ordenes_en_escrow,
--        SUM(o.work_total) FILTER (WHERE o.status='completed') AS monto_en_escrow
-- FROM wallets w
-- JOIN users u ON u.id = w.user_id
-- LEFT JOIN orders o ON o.provider_id = w.user_id
-- GROUP BY u.full_name, w.balance, w.blocked_balance;

-- ── Fix: actualizar blocked_balance del proveedor para órdenes completadas
-- Ejecutar si hay órdenes en 'completed' que no se ven en el escrow del proveedor
-- (Esto recalcula el monto en escrow para TODOS los proveedores)
UPDATE wallets w
SET blocked_balance = COALESCE((
  SELECT SUM(o.work_total)
  FROM orders o
  WHERE o.provider_id = w.user_id
    AND o.status = 'completed'
    AND o.work_paid = false
), 0)
WHERE user_id IN (
  SELECT DISTINCT provider_id FROM orders
  WHERE status = 'completed' AND work_paid = false
);

-- ── Provider stats: rating, orders, points son columnas en provider_profiles
-- Si no tienen datos reales, recalcular:
UPDATE provider_profiles pp
SET
  rating_avg    = COALESCE((SELECT AVG(o.client_rating) FROM orders o WHERE o.provider_id = pp.user_id AND o.client_rating IS NOT NULL), 0),
  rating_count  = COALESCE((SELECT COUNT(*) FROM orders o WHERE o.provider_id = pp.user_id AND o.client_rating IS NOT NULL), 0),
  orders_completed = COALESCE((SELECT COUNT(*) FROM orders o WHERE o.provider_id = pp.user_id AND o.status IN ('confirmed')), 0)
WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = pp.user_id AND u.role = 'provider');
