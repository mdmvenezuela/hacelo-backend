-- ══════════════════════════════════════════════════════════════
-- HACELO — Schema completo de la base de datos
-- Ejecutar en orden. Usar: node db/migrate.js
-- ══════════════════════════════════════════════════════════════

-- ── EXTENSIONES ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- Para búsqueda de texto

-- ══════════════════════════════════════════════════════════════
-- ENUMS
-- ══════════════════════════════════════════════════════════════

CREATE TYPE user_role AS ENUM ('client', 'provider', 'admin');
CREATE TYPE provider_level AS ENUM ('lila', 'plata', 'oro');
CREATE TYPE order_status AS ENUM (
  'requested',       -- ⭕ Solicitada
  'accepted',        -- 🟡 Aceptada
  'in_conversation', -- 💬 En conversación
  'on_the_way',      -- 🚗 En camino
  'diagnosing',      -- 🔍 En diagnóstico (visita cobrada)
  'quote_sent',      -- 📋 Presupuesto enviado
  'pending_payment', -- 💳 Por pagar
  'in_progress',     -- ⚡ En ejecución
  'completed',       -- ✅ Completada
  'disputed',        -- ⚠️ En disputa
  'cancelled',       -- ❌ Cancelada
  'expired'          -- ⏰ Expirada (timeout)
);
CREATE TYPE wallet_tx_type AS ENUM (
  'recharge',         -- Recarga del cliente
  'visit_block',      -- Bloqueo por visita
  'visit_charge',     -- Cobro de visita al técnico llegar
  'visit_unblock',    -- Desbloqueo si proveedor cancela
  'work_block',       -- Bloqueo del presupuesto de trabajo
  'work_release',     -- Liberación al proveedor al completar
  'work_unblock',     -- Desbloqueo al cliente si cancela
  'commission',       -- Comisión descontada a proveedor
  'withdrawal',       -- Retiro del proveedor
  'refund',           -- Reembolso
  'adjustment'        -- Ajuste manual del admin
);
CREATE TYPE wallet_tx_status AS ENUM ('pending', 'approved', 'rejected', 'cancelled');
CREATE TYPE recharge_status AS ENUM ('pending', 'approved', 'rejected', 'info_requested');
CREATE TYPE withdrawal_status AS ENUM ('pending', 'processing', 'completed', 'rejected');
CREATE TYPE dispute_status AS ENUM ('open', 'investigating', 'resolved_client', 'resolved_provider', 'closed');
CREATE TYPE notification_type AS ENUM (
  'order_requested', 'order_accepted', 'order_rejected', 'order_on_the_way',
  'order_arrived', 'quote_received', 'payment_required', 'payment_confirmed',
  'work_completed', 'order_disputed', 'order_cancelled', 'recharge_approved',
  'recharge_rejected', 'withdrawal_completed', 'new_message', 'new_review'
);
CREATE TYPE payment_method_type AS ENUM (
  'pago_movil', 'zelle', 'binance', 'bank_transfer', 'other'
);

-- ══════════════════════════════════════════════════════════════
-- TABLA: users (tabla base para todos los usuarios)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  firebase_uid    VARCHAR(128) UNIQUE,           -- Firebase Auth UID
  email           VARCHAR(255) UNIQUE NOT NULL,
  phone           VARCHAR(20),
  phone_verified  BOOLEAN DEFAULT FALSE,
  full_name       VARCHAR(255) NOT NULL,
  avatar_url      TEXT,
  role            user_role NOT NULL DEFAULT 'client',
  is_active       BOOLEAN DEFAULT TRUE,
  is_verified     BOOLEAN DEFAULT FALSE,         -- Verificado por admin
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Índices
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_firebase_uid ON users(firebase_uid);
CREATE INDEX idx_users_role ON users(role);

-- ══════════════════════════════════════════════════════════════
-- TABLA: client_profiles
-- ══════════════════════════════════════════════════════════════
CREATE TABLE client_profiles (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address             TEXT,
  city                VARCHAR(100) DEFAULT 'Cabimas',
  state               VARCHAR(100) DEFAULT 'Zulia',
  -- Control de abuso
  rejection_count     INTEGER DEFAULT 0,   -- rechazos de cotización este mes
  rejection_reset_at  TIMESTAMPTZ DEFAULT NOW(),
  is_suspended        BOOLEAN DEFAULT FALSE,
  suspended_until     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- ══════════════════════════════════════════════════════════════
-- TABLA: provider_profiles
-- ══════════════════════════════════════════════════════════════
CREATE TABLE provider_profiles (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bio                   TEXT,
  city                  VARCHAR(100) DEFAULT 'Cabimas',
  state                 VARCHAR(100) DEFAULT 'Zulia',
  coverage_zones        TEXT[],               -- Zonas/sectores donde atiende
  visit_price           DECIMAL(10,2) NOT NULL DEFAULT 5.00, -- Precio de visita
  level                 provider_level DEFAULT 'lila',
  points                INTEGER DEFAULT 0,
  rating_avg            DECIMAL(3,2) DEFAULT 0.00,
  rating_count          INTEGER DEFAULT 0,
  orders_completed      INTEGER DEFAULT 0,
  years_experience      INTEGER DEFAULT 0,
  -- Control de cancelaciones
  cancel_count          INTEGER DEFAULT 0,
  cancel_reset_at       TIMESTAMPTZ DEFAULT NOW(),
  is_suspended          BOOLEAN DEFAULT FALSE,
  suspended_until       TIMESTAMPTZ,
  -- Disponibilidad
  is_available          BOOLEAN DEFAULT TRUE,  -- Toggle manual
  is_verified           BOOLEAN DEFAULT FALSE, -- Verificado por admin
  id_document_url       TEXT,                  -- Foto de cédula
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE INDEX idx_provider_city ON provider_profiles(city);
CREATE INDEX idx_provider_level ON provider_profiles(level);
CREATE INDEX idx_provider_rating ON provider_profiles(rating_avg DESC);

-- ══════════════════════════════════════════════════════════════
-- TABLA: categories (administradas desde el panel admin)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE categories (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(100) NOT NULL,
  slug        VARCHAR(100) UNIQUE NOT NULL,
  icon        VARCHAR(10),                 -- Emoji o código de ícono
  color       VARCHAR(7),                  -- Hex color para el UI
  description TEXT,
  is_active   BOOLEAN DEFAULT TRUE,
  sort_order  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════════
-- TABLA: provider_services (qué servicios ofrece cada proveedor)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE provider_services (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_id   UUID NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  category_id   UUID NOT NULL REFERENCES categories(id),
  title         VARCHAR(255) NOT NULL,
  description   TEXT,
  skills        TEXT[],         -- Tags: Instalación, Reparación, etc.
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(provider_id, category_id)
);

CREATE INDEX idx_provider_services_cat ON provider_services(category_id);

-- ══════════════════════════════════════════════════════════════
-- TABLA: provider_schedule (horario semanal del proveedor)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE provider_schedule (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_id   UUID NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  day_of_week   SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Dom
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  is_available  BOOLEAN DEFAULT TRUE,
  UNIQUE(provider_id, day_of_week)
);

-- ══════════════════════════════════════════════════════════════
-- TABLA: provider_gallery (fotos de trabajos anteriores)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE provider_gallery (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_id   UUID NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  image_url     TEXT NOT NULL,
  caption       TEXT,
  sort_order    INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════════
-- TABLA: wallets
-- ══════════════════════════════════════════════════════════════
CREATE TABLE wallets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance         DECIMAL(12,2) DEFAULT 0.00,   -- Saldo disponible
  blocked_balance DECIMAL(12,2) DEFAULT 0.00,   -- Saldo bloqueado (escrow)
  total_earned    DECIMAL(12,2) DEFAULT 0.00,   -- Solo proveedores: total ganado histórico
  total_withdrawn DECIMAL(12,2) DEFAULT 0.00,   -- Solo proveedores: total retirado
  currency        VARCHAR(3) DEFAULT 'USD',
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- ══════════════════════════════════════════════════════════════
-- TABLA: wallet_transactions (log inmutable de todos los movimientos)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE wallet_transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_id       UUID NOT NULL REFERENCES wallets(id),
  type            wallet_tx_type NOT NULL,
  status          wallet_tx_status DEFAULT 'pending',
  amount          DECIMAL(12,2) NOT NULL,
  balance_before  DECIMAL(12,2) NOT NULL,        -- Snapshot del saldo antes
  balance_after   DECIMAL(12,2) NOT NULL,        -- Snapshot del saldo después
  reference_id    UUID,                          -- ID de la orden o recarga relacionada
  reference_type  VARCHAR(50),                   -- 'order', 'recharge', 'withdrawal'
  description     TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
  -- NO updated_at: este log es inmutable
);

CREATE INDEX idx_wallet_tx_wallet ON wallet_transactions(wallet_id);
CREATE INDEX idx_wallet_tx_type ON wallet_transactions(type);
CREATE INDEX idx_wallet_tx_ref ON wallet_transactions(reference_id);
CREATE INDEX idx_wallet_tx_created ON wallet_transactions(created_at DESC);

-- ══════════════════════════════════════════════════════════════
-- TABLA: payment_methods (administradas desde el panel admin)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE payment_methods (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name              VARCHAR(100) NOT NULL,       -- "Pago Móvil Bancamiga"
  type              payment_method_type NOT NULL,
  currency          VARCHAR(3) NOT NULL DEFAULT 'USD',
  logo_url          TEXT,
  instructions      TEXT,                        -- Texto de instrucciones para el cliente
  fields            JSONB NOT NULL DEFAULT '[]', -- Campos dinámicos [{ label, value, copyable }]
  min_amount        DECIMAL(10,2) DEFAULT 1.00,
  max_amount        DECIMAL(10,2) DEFAULT 1000.00,
  verification_time VARCHAR(50) DEFAULT '1-4 horas',
  is_active         BOOLEAN DEFAULT TRUE,
  sort_order        INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════════
-- TABLA: recharge_requests (solicitudes de recarga del cliente)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE recharge_requests (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id),
  wallet_id           UUID NOT NULL REFERENCES wallets(id),
  payment_method_id   UUID NOT NULL REFERENCES payment_methods(id),
  amount              DECIMAL(10,2) NOT NULL,
  reference_number    VARCHAR(255) NOT NULL,     -- Número de referencia del banco
  payment_date        TIMESTAMPTZ NOT NULL,       -- Fecha del pago según el cliente
  origin_bank         VARCHAR(100),
  receipt_url         TEXT,                       -- Comprobante (imagen en Cloudinary)
  notes               TEXT,                       -- Nota adicional del cliente
  status              recharge_status DEFAULT 'pending',
  admin_notes         TEXT,                       -- Notas del admin al revisar
  reviewed_by         UUID REFERENCES users(id), -- Admin que revisó
  reviewed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_recharge_user ON recharge_requests(user_id);
CREATE INDEX idx_recharge_status ON recharge_requests(status);
CREATE INDEX idx_recharge_created ON recharge_requests(created_at DESC);

-- ══════════════════════════════════════════════════════════════
-- TABLA: withdrawal_requests (solicitudes de retiro del proveedor)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE withdrawal_requests (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id),
  wallet_id           UUID NOT NULL REFERENCES wallets(id),
  amount              DECIMAL(10,2) NOT NULL,
  payment_method_id   UUID REFERENCES payment_methods(id),
  payout_details      JSONB NOT NULL DEFAULT '{}', -- Datos del destino (teléfono, email, etc.)
  status              withdrawal_status DEFAULT 'pending',
  admin_notes         TEXT,
  processed_by        UUID REFERENCES users(id),
  processed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_withdrawal_user ON withdrawal_requests(user_id);
CREATE INDEX idx_withdrawal_status ON withdrawal_requests(status);

-- ══════════════════════════════════════════════════════════════
-- TABLA: orders (el corazón del sistema)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE orders (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_number          SERIAL UNIQUE,             -- #000001, #000002...
  client_id             UUID NOT NULL REFERENCES users(id),
  provider_id           UUID REFERENCES users(id), -- NULL hasta que acepta
  category_id           UUID NOT NULL REFERENCES categories(id),

  -- Descripción del problema
  title                 VARCHAR(255) NOT NULL,
  description           TEXT,
  photos                TEXT[],                    -- URLs de fotos adjuntas

  -- Ubicación
  address               TEXT NOT NULL,
  city                  VARCHAR(100) NOT NULL,
  latitude              DECIMAL(10,8),
  longitude             DECIMAL(11,8),

  -- Urgencia
  is_urgent             BOOLEAN DEFAULT FALSE,
  scheduled_at          TIMESTAMPTZ,               -- Si eligió fecha específica

  -- Precio de visita (snapshot al momento de crear la orden)
  visit_price           DECIMAL(10,2) NOT NULL,
  visit_paid            BOOLEAN DEFAULT FALSE,     -- Si ya se cobró la visita
  visit_charged_at      TIMESTAMPTZ,

  -- Presupuesto del trabajo (lo agrega el proveedor)
  work_total            DECIMAL(10,2),             -- Calculado de los ítems
  work_paid             BOOLEAN DEFAULT FALSE,
  work_paid_at          TIMESTAMPTZ,

  -- Comisiones
  commission_rate       DECIMAL(5,4),              -- Snapshot de la tasa al momento
  commission_amount     DECIMAL(10,2),             -- Comisión total cobrada

  -- Estado
  status                order_status DEFAULT 'requested',

  -- Timestamps de cambios de estado (para auditoría y métricas)
  accepted_at           TIMESTAMPTZ,
  on_the_way_at         TIMESTAMPTZ,
  arrived_at            TIMESTAMPTZ,
  quote_sent_at         TIMESTAMPTZ,
  work_started_at       TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  confirmed_at          TIMESTAMPTZ,               -- Cuando cliente confirma
  cancelled_at          TIMESTAMPTZ,
  cancelled_by          UUID REFERENCES users(id),
  cancel_reason         TEXT,

  -- Disputa
  disputed_at           TIMESTAMPTZ,
  dispute_resolved_at   TIMESTAMPTZ,

  -- Auto-expiración
  expires_at            TIMESTAMPTZ,               -- Para el timeout de aceptación
  confirm_deadline      TIMESTAMPTZ,               -- 48h para que cliente confirme

  -- Garantía
  warranty_days         INTEGER DEFAULT 0,
  warranty_expires_at   TIMESTAMPTZ,

  -- Calificación
  client_rating         SMALLINT CHECK (client_rating BETWEEN 1 AND 5),
  client_review         TEXT,
  client_rated_at       TIMESTAMPTZ,

  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_orders_client ON orders(client_id);
CREATE INDEX idx_orders_provider ON orders(provider_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_category ON orders(category_id);
CREATE INDEX idx_orders_created ON orders(created_at DESC);
CREATE INDEX idx_orders_number ON orders(order_number);

-- ══════════════════════════════════════════════════════════════
-- TABLA: order_items (ítems del presupuesto de trabajo)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE order_items (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,    -- "Mano de obra", "Breaker 20A"
  description TEXT,
  quantity    DECIMAL(8,2) DEFAULT 1,
  unit_price  DECIMAL(10,2) NOT NULL,
  total       DECIMAL(10,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  sort_order  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_order_items_order ON order_items(order_id);

-- ══════════════════════════════════════════════════════════════
-- TABLA: messages (chat entre cliente y proveedor por orden)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sender_id   UUID NOT NULL REFERENCES users(id),
  content     TEXT,
  image_url   TEXT,
  is_system   BOOLEAN DEFAULT FALSE,   -- Mensajes automáticos del sistema
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_order ON messages(order_id);
CREATE INDEX idx_messages_created ON messages(created_at ASC);

-- ══════════════════════════════════════════════════════════════
-- TABLA: disputes
-- ══════════════════════════════════════════════════════════════
CREATE TABLE disputes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID NOT NULL REFERENCES orders(id),
  opened_by       UUID NOT NULL REFERENCES users(id),
  reason          TEXT NOT NULL,
  evidence_urls   TEXT[],
  status          dispute_status DEFAULT 'open',
  admin_notes     TEXT,
  resolved_by     UUID REFERENCES users(id),
  resolved_at     TIMESTAMPTZ,
  resolution      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════════
-- TABLA: certifications (certificados verificados del proveedor)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE certifications (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_id   UUID NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  title         VARCHAR(255) NOT NULL,
  issued_by     VARCHAR(255),
  issued_at     DATE,
  document_url  TEXT,
  is_verified   BOOLEAN DEFAULT FALSE,  -- Verificado por admin
  verified_by   UUID REFERENCES users(id),
  verified_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════════
-- TABLA: favorites (proveedores favoritos del cliente)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE favorites (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, provider_id)
);

-- ══════════════════════════════════════════════════════════════
-- TABLA: notifications
-- ══════════════════════════════════════════════════════════════
CREATE TABLE notifications (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          notification_type NOT NULL,
  title         VARCHAR(255) NOT NULL,
  body          TEXT NOT NULL,
  data          JSONB DEFAULT '{}',       -- Datos extra (order_id, etc.)
  is_read       BOOLEAN DEFAULT FALSE,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notif_user ON notifications(user_id);
CREATE INDEX idx_notif_read ON notifications(user_id, is_read);
CREATE INDEX idx_notif_created ON notifications(created_at DESC);

-- ══════════════════════════════════════════════════════════════
-- TABLA: referrals
-- ══════════════════════════════════════════════════════════════
CREATE TABLE referrals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  referrer_id     UUID NOT NULL REFERENCES users(id),
  referred_id     UUID NOT NULL REFERENCES users(id),
  code            VARCHAR(20) UNIQUE NOT NULL,
  reward_granted  BOOLEAN DEFAULT FALSE,
  reward_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(referred_id)
);

-- ══════════════════════════════════════════════════════════════
-- FUNCIÓN: actualizar updated_at automáticamente
-- ══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Aplicar trigger a todas las tablas con updated_at
CREATE TRIGGER trg_users_updated_at               BEFORE UPDATE ON users               FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_client_profiles_updated_at     BEFORE UPDATE ON client_profiles     FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_provider_profiles_updated_at   BEFORE UPDATE ON provider_profiles   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_wallets_updated_at             BEFORE UPDATE ON wallets             FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_payment_methods_updated_at     BEFORE UPDATE ON payment_methods     FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_recharge_requests_updated_at   BEFORE UPDATE ON recharge_requests   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_withdrawal_requests_updated_at BEFORE UPDATE ON withdrawal_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_orders_updated_at              BEFORE UPDATE ON orders              FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_disputes_updated_at            BEFORE UPDATE ON disputes            FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ══════════════════════════════════════════════════════════════
-- FUNCIÓN: recalcular work_total al agregar/editar ítems
-- ══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION recalculate_order_work_total()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE orders
  SET work_total = (
    SELECT COALESCE(SUM(total), 0)
    FROM order_items
    WHERE order_id = COALESCE(NEW.order_id, OLD.order_id)
  )
  WHERE id = COALESCE(NEW.order_id, OLD.order_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_recalc_work_total
AFTER INSERT OR UPDATE OR DELETE ON order_items
FOR EACH ROW EXECUTE FUNCTION recalculate_order_work_total();

-- ══════════════════════════════════════════════════════════════
-- FUNCIÓN: actualizar rating del proveedor al nuevo review
-- ══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION update_provider_rating()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.client_rating IS NOT NULL AND OLD.client_rating IS NULL THEN
    UPDATE provider_profiles pp
    SET
      rating_count = rating_count + 1,
      rating_avg = (
        SELECT ROUND(AVG(client_rating)::numeric, 2)
        FROM orders
        WHERE provider_id = NEW.provider_id
          AND client_rating IS NOT NULL
      )
    FROM users u
    WHERE u.id = NEW.provider_id
      AND pp.user_id = u.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_provider_rating
AFTER UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION update_provider_rating();