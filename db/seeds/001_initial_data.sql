-- ══════════════════════════════════════════════════════════════
-- HACELO — Seeds iniciales
-- ══════════════════════════════════════════════════════════════

-- ── Categorías de servicios ─────────────────────────────────
INSERT INTO categories (name, slug, icon, color, description, sort_order) VALUES
  ('Plomería',         'plomeria',         '🔧', '#3B82F6', 'Tuberías, grifos, filtraciones y todo lo relacionado con agua',      1),
  ('Electricidad',     'electricidad',     '⚡', '#F59E0B', 'Instalaciones eléctricas, tableros, tomas y luminarias',             2),
  ('Mecánica',         'mecanica',         '🚗', '#6B7280', 'Revisión y reparación de vehículos a domicilio',                     3),
  ('Línea Blanca',     'linea-blanca',     '❄️', '#06B6D4', 'Lavadoras, neveras, secadoras, aires acondicionados',               4),
  ('Carpintería',      'carpinteria',      '🪚', '#92400E', 'Muebles, puertas, pisos de madera y trabajos en madera',            5),
  ('Pintura',          'pintura',          '🎨', '#EC4899', 'Pintura de paredes interiores, exteriores y fachadas',              6),
  ('Limpieza',         'limpieza',         '🏠', '#10B981', 'Limpieza del hogar, oficinas y locales comerciales',                7),
  ('Albañilería',      'albanileria',      '🧱', '#78716C', 'Construcción, reparación de paredes, pisos y acabados',            8),
  ('Jardinería',       'jardineria',       '🌿', '#16A34A', 'Mantenimiento de jardines, poda y paisajismo',                     9),
  ('A/C & Refrigeración', 'ac-refrigeracion', '🌬️', '#0EA5E9', 'Instalación y mantenimiento de aires acondicionados',          10),
  ('Cerrajería',       'cerrajeria',       '🔑', '#7C3AED', 'Apertura de puertas, cambio de cerraduras y copias de llaves',    11),
  ('Electrónica',      'electronica',      '📱', '#6366F1', 'Reparación de celulares, computadoras y electrónicos',            12),
  ('Chef a domicilio', 'chef',             '👨‍🍳', '#F97316', 'Preparación de comidas, eventos y catering',                    13),
  ('Belleza',          'belleza',          '💅', '#DB2777', 'Peluquería, manicure, maquillaje y spa a domicilio',              14),
  ('Mecánica Automotriz', 'mecanica-auto', '🔩', '#475569', 'Mantenimiento preventivo y correctivo de vehículos',              15),
  ('Clases & Tutorías','clases',           '📚', '#7C3AED', 'Clases particulares de cualquier materia o habilidad',            16),
  ('Entrenamiento',    'entrenamiento',    '💪', '#EF4444', 'Entrenador personal a domicilio o en exteriores',                 17),
  ('Mandados',         'mandados',         '📦', '#F59E0B', 'Mensajería, compras y trámites personales',                      18),
  ('Fotografía',       'fotografia',       '📸', '#8B5CF6', 'Fotografía de eventos, retratos y productos',                    19),
  ('Mascotas',         'mascotas',         '🐾', '#F97316', 'Peluquería, cuidado y adiestramiento de mascotas',               20);

-- ── Métodos de pago iniciales ───────────────────────────────
INSERT INTO payment_methods (name, type, currency, instructions, fields, min_amount, max_amount, verification_time, sort_order) VALUES
(
  'Pago Móvil',
  'pago_movil',
  'USD',
  'Realiza una transferencia por Pago Móvil usando los datos a continuación. Luego sube el comprobante.',
  '[
    {"label": "Banco", "value": "Bancamiga", "copyable": false},
    {"label": "Teléfono", "value": "0414-000-0000", "copyable": true},
    {"label": "Cédula", "value": "V-00.000.000", "copyable": true},
    {"label": "Titular", "value": "Hacelo C.A.", "copyable": false}
  ]'::jsonb,
  1.00, 500.00, '1-4 horas', 1
),
(
  'Zelle',
  'zelle',
  'USD',
  'Envía el pago por Zelle a los datos de abajo. Asegúrate de incluir tu nombre en el concepto.',
  '[
    {"label": "Email", "value": "pagos@hacelo.app", "copyable": true},
    {"label": "Nombre", "value": "Hacelo Services", "copyable": false}
  ]'::jsonb,
  5.00, 1000.00, '1-2 horas', 2
),
(
  'Binance Pay',
  'binance',
  'USD',
  'Envía USDT por Binance Pay usando nuestro Pay ID o alias.',
  '[
    {"label": "Pay ID", "value": "000000000", "copyable": true},
    {"label": "Alias", "value": "@hacelo", "copyable": true},
    {"label": "Red", "value": "BEP20 / TRC20", "copyable": false}
  ]'::jsonb,
  2.00, 2000.00, '30 min - 1 hora', 3
),
(
  'Transferencia Bancaria',
  'bank_transfer',
  'USD',
  'Realiza una transferencia bancaria a la cuenta indicada. El tiempo de verificación puede ser mayor.',
  '[
    {"label": "Banco", "value": "Banco del Tesoro", "copyable": false},
    {"label": "Cuenta", "value": "0163-0000-00-0000000000", "copyable": true},
    {"label": "Titular", "value": "Hacelo C.A.", "copyable": false},
    {"label": "RIF", "value": "J-00000000-0", "copyable": true}
  ]'::jsonb,
  10.00, 5000.00, '24-48 horas', 4
);

-- ── Usuario admin inicial ───────────────────────────────────
-- Password: Admin@Hacelo2025! (cambiar inmediatamente)
INSERT INTO users (email, full_name, role, is_active, is_verified) VALUES
  ('admin@hacelo.app', 'Administrador Hacelo', 'admin', true, true);