-- ══════════════════════════════════════════════════════════════
-- HACELO — Migración 002: KYC + mejoras
-- ══════════════════════════════════════════════════════════════

-- ── KYC status enum ───────────────────────────────────────────
CREATE TYPE kyc_status AS ENUM ('pending', 'under_review', 'approved', 'rejected');

-- ── Tabla KYC ─────────────────────────────────────────────────
CREATE TABLE provider_kyc (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Documentos
  selfie_url          TEXT,
  id_front_url        TEXT,
  id_back_url         TEXT,
  rif_url             TEXT,
  video_selfie_url    TEXT,
  -- Datos del documento
  full_name_doc       VARCHAR(255),   -- Nombre exacto en el documento
  id_number           VARCHAR(50),    -- Número de cédula
  rif_number          VARCHAR(50),    -- RIF
  -- Estado
  status              kyc_status DEFAULT 'pending',
  rejection_reason    TEXT,
  submitted_at        TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at         TIMESTAMPTZ,
  reviewed_by         UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE INDEX idx_kyc_status ON provider_kyc(status);
CREATE INDEX idx_kyc_user ON provider_kyc(user_id);

CREATE TRIGGER trg_kyc_updated_at
BEFORE UPDATE ON provider_kyc
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Agregar kyc_status a provider_profiles ────────────────────
ALTER TABLE provider_profiles
  ADD COLUMN IF NOT EXISTS kyc_status kyc_status DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS kyc_submitted_at TIMESTAMPTZ;

-- ── Agregar campos de reseña a orders (separados del rating) ──
-- (ya existen client_rating y client_review, están bien)

-- ── Índice para auto-cancelación por expiración ───────────────
CREATE INDEX IF NOT EXISTS idx_orders_expires
  ON orders(expires_at, status)
  WHERE status = 'requested';

-- ── Función auto-cancelar órdenes expiradas ───────────────────
-- Se llama periódicamente desde el job en Node.js
CREATE OR REPLACE FUNCTION cancel_expired_orders()
RETURNS INTEGER AS $$
DECLARE
  cancelled_count INTEGER := 0;
  order_record RECORD;
BEGIN
  FOR order_record IN
    SELECT id, client_id, visit_price
    FROM orders
    WHERE status = 'requested'
      AND expires_at IS NOT NULL
      AND expires_at < NOW()
  LOOP
    -- Cancelar la orden
    UPDATE orders
    SET status = 'cancelled',
        cancelled_at = NOW(),
        cancel_reason = 'Expirada — el proveedor no respondió en 30 minutos'
    WHERE id = order_record.id;

    -- Desbloquear saldo del cliente
    UPDATE wallets
    SET balance = balance + order_record.visit_price,
        blocked_balance = blocked_balance - order_record.visit_price
    WHERE user_id = order_record.client_id;

    cancelled_count := cancelled_count + 1;
  END LOOP;

  RETURN cancelled_count;
END;
$$ LANGUAGE plpgsql;

-- ── Función auto-confirmar órdenes completadas sin respuesta ──
CREATE OR REPLACE FUNCTION auto_confirm_completed_orders()
RETURNS INTEGER AS $$
DECLARE
  confirmed_count INTEGER := 0;
  order_record RECORD;
  commission_rate DECIMAL;
  commission_amount DECIMAL;
  net_amount DECIMAL;
BEGIN
  FOR order_record IN
    SELECT o.id, o.client_id, o.provider_id, o.work_total, o.commission_rate
    FROM orders o
    WHERE o.status = 'completed'
      AND o.confirm_deadline IS NOT NULL
      AND o.confirm_deadline < NOW()
  LOOP
    commission_rate   := COALESCE(order_record.commission_rate, 0.135);
    commission_amount := ROUND((order_record.work_total * commission_rate)::numeric, 2);
    net_amount        := order_record.work_total - commission_amount;

    -- Confirmar orden
    UPDATE orders
    SET status = 'confirmed',
        confirmed_at = NOW(),
        work_paid = true,
        work_paid_at = NOW()
    WHERE id = order_record.id;

    -- Desbloquear del cliente y acreditar al proveedor
    UPDATE wallets
    SET blocked_balance = blocked_balance - order_record.work_total
    WHERE user_id = order_record.client_id;

    UPDATE wallets
    SET balance = balance + net_amount,
        total_earned = total_earned + net_amount
    WHERE user_id = order_record.provider_id;

    -- Sumar puntos al proveedor
    UPDATE provider_profiles
    SET points = points + 1,
        orders_completed = orders_completed + 1
    WHERE user_id = order_record.provider_id;

    confirmed_count := confirmed_count + 1;
  END LOOP;

  RETURN confirmed_count;
END;
$$ LANGUAGE plpgsql;
