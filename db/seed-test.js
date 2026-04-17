// ══════════════════════════════════════════
// Script para crear datos de prueba
// Uso: node db/seed-test.js
// ══════════════════════════════════════════

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function seedTest() {
  const client = await pool.connect();

  try {
    console.log('🌱 Creando datos de prueba...');
    await client.query('BEGIN');

    const password = await bcrypt.hash('Test1234!', 12);

    // ── Categorías (obtenemos los IDs que ya existen) ──────
    const { rows: cats } = await client.query(
      `SELECT id, slug FROM categories WHERE slug IN
       ('electricidad','plomeria','mecanica','ac-refrigeracion','limpieza')`
    );
    const catMap = {};
    cats.forEach(c => catMap[c.slug] = c.id);

    // ── Proveedores de prueba ──────────────────────────────
    const providers = [
      {
        email: 'luis@test.com', fullName: 'Luis Fuenmayor',
        bio: 'Electricista certificado con más de 3 años en instalaciones residenciales y comerciales en Cabimas. Trabajo con garantía en todos mis servicios.',
        visitPrice: 10, categorySlug: 'electricidad',
        skills: ['Instalación', 'Reparación', 'Tableros', 'Plantas eléctricas'],
        zones: ['Centro', 'La Victoria', 'Los Laureles'],
        rating: 4.9, ratingCount: 82, orders: 120, years: 3,
      },
      {
        email: 'pedro@test.com', fullName: 'Pedro Bracho',
        bio: 'Plomero con experiencia en reparación de tuberías, grifería y sistemas de aguas. Atiendo emergencias 24/7.',
        visitPrice: 8, categorySlug: 'plomeria',
        skills: ['Tuberías', 'Filtraciones', 'Grifería', 'Aguas blancas'],
        zones: ['Centro', 'Tierra Negra', 'Campo Alegre'],
        rating: 4.7, ratingCount: 45, orders: 67, years: 5,
      },
      {
        email: 'jose@test.com', fullName: 'José Urdaneta',
        bio: 'Mecánico automotriz a domicilio. Diagnóstico computarizado, cambio de aceite, frenos, suspensión y más.',
        visitPrice: 15, categorySlug: 'mecanica',
        skills: ['Diagnóstico', 'Frenos', 'Suspensión', 'Cambio de aceite'],
        zones: ['Centro', 'La Paz', 'Los Laureles', 'Tierra Negra'],
        rating: 5.0, ratingCount: 28, orders: 40, years: 8,
      },
      {
        email: 'maria@test.com', fullName: 'María González',
        bio: 'Técnica especialista en aires acondicionados y refrigeración. Instalación, mantenimiento y reparación de todas las marcas.',
        visitPrice: 12, categorySlug: 'ac-refrigeracion',
        skills: ['Instalación A/C', 'Mantenimiento', 'Reparación', 'Neveras'],
        zones: ['Centro', 'La Victoria', 'Campo Alegre'],
        rating: 4.8, ratingCount: 56, orders: 89, years: 4,
      },
      {
        email: 'carmen@test.com', fullName: 'Carmen Villalobos',
        bio: 'Servicio de limpieza del hogar y oficinas. Personal de confianza, equipos propios y productos de calidad.',
        visitPrice: 5, categorySlug: 'limpieza',
        skills: ['Limpieza de hogar', 'Oficinas', 'Post-obra', 'Vidrios'],
        zones: ['Centro', 'Los Laureles', 'La Victoria', 'Tierra Negra'],
        rating: 4.6, ratingCount: 34, orders: 78, years: 2,
      },
    ];

    for (const p of providers) {
      // Verificar si ya existe
      const { rows: existing } = await client.query(
        'SELECT id FROM users WHERE email = $1', [p.email]
      );
      if (existing.length) {
        console.log(`⏭️  Ya existe: ${p.email}`);
        continue;
      }

      // Crear usuario
      const { rows: [user] } = await client.query(`
        INSERT INTO users (email, full_name, role, is_active, is_verified)
        VALUES ($1, $2, 'provider', true, true) RETURNING id
      `, [p.email, p.fullName]);

      // Crear perfil proveedor
      const { rows: [profile] } = await client.query(`
        INSERT INTO provider_profiles
          (user_id, bio, city, state, visit_price, coverage_zones,
           rating_avg, rating_count, orders_completed, years_experience,
           is_available, is_verified, level)
        VALUES ($1,$2,'Cabimas','Zulia',$3,$4,$5,$6,$7,$8,true,true,'lila')
        RETURNING id
      `, [user.id, p.bio, p.visitPrice, p.zones,
          p.rating, p.ratingCount, p.orders, p.years]);

      // Crear servicio
      if (catMap[p.categorySlug]) {
        await client.query(`
          INSERT INTO provider_services (provider_id, category_id, title, skills)
          VALUES ($1, $2, $3, $4)
        `, [profile.id, catMap[p.categorySlug],
            `${p.fullName} — ${p.categorySlug}`, p.skills]);
      }

      // Crear wallet
      await client.query(
        'INSERT INTO wallets (user_id, balance) VALUES ($1, 0)', [user.id]
      );

      // Crear horario de lunes a sábado 8am-6pm
      for (let day = 1; day <= 6; day++) {
        await client.query(`
          INSERT INTO provider_schedule (provider_id, day_of_week, start_time, end_time)
          VALUES ($1, $2, '08:00', '18:00')
        `, [profile.id, day]);
      }

      console.log(`✅ Creado proveedor: ${p.fullName} (${p.email}) | Visita: $${p.visitPrice}`);
    }

    // ── Cliente de prueba ──────────────────────────────────
    const { rows: existingClient } = await client.query(
      'SELECT id FROM users WHERE email = $1', ['cliente@test.com']
    );

    if (!existingClient.length) {
      const { rows: [clientUser] } = await client.query(`
        INSERT INTO users (email, full_name, role, is_active)
        VALUES ('cliente@test.com', 'Carlos Mendoza', 'client', true) RETURNING id
      `);
      await client.query(
        'INSERT INTO client_profiles (user_id) VALUES ($1)', [clientUser.id]
      );
      // Wallet con $50 de saldo para pruebas
      await client.query(
        'INSERT INTO wallets (user_id, balance) VALUES ($1, 50.00)', [clientUser.id]
      );
      console.log('✅ Cliente de prueba: cliente@test.com | Saldo: $50.00');
    } else {
      // Asegurarse que tenga saldo
      await client.query(
        'UPDATE wallets SET balance = 50.00 WHERE user_id = (SELECT id FROM users WHERE email = $1)',
        ['cliente@test.com']
      );
      console.log('⏭️  Cliente ya existe, saldo actualizado a $50.00');
    }

    await client.query('COMMIT');
    console.log('\n🎉 Datos de prueba listos!\n');
    console.log('──────────────────────────────────────────');
    console.log('PROVEEDORES (contraseña no aplica, login directo en admin):');
    providers.forEach(p => console.log(`  • ${p.fullName} — ${p.email}`));
    console.log('\nCLIENTE DE PRUEBA:');
    console.log('  Email:    cliente@test.com');
    console.log('  Password: Test1234!');
    console.log('  Saldo:    $50.00 USD');
    console.log('──────────────────────────────────────────\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error:', err.message);
    console.error(err.detail || '');
  } finally {
    client.release();
    await pool.end();
  }
}

seedTest();
