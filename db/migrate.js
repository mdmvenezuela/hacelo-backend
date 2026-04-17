// ══════════════════════════════════════════════════════════════
// HACELO — Runner de migraciones
// Uso: node db/migrate.js           → Ejecuta migraciones pendientes
//      node db/migrate.js --fresh   → Borra todo y re-crea (CUIDADO)
//      node db/seed.js              → Carga datos iniciales
// ══════════════════════════════════════════════════════════════

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const isFresh = process.argv.includes('--fresh');

async function migrate() {
  const client = await pool.connect();

  try {
    console.log('🔌 Conectando a PostgreSQL...');

    if (isFresh) {
      console.log('⚠️  Modo FRESH: eliminando schema público...');
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      console.log('✅ Schema limpio');
    }

    // Crear tabla de control de migraciones
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         SERIAL PRIMARY KEY,
        filename   VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let executed = 0;

    for (const file of files) {
      const { rows } = await client.query(
        'SELECT id FROM _migrations WHERE filename = $1', [file]
      );

      if (rows.length > 0) {
        console.log(`⏭️  Ya ejecutada: ${file}`);
        continue;
      }

      console.log(`⚙️  Ejecutando: ${file}...`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO _migrations (filename) VALUES ($1)', [file]
      );
      await client.query('COMMIT');

      console.log(`✅ Completada: ${file}`);
      executed++;
    }

    if (executed === 0) {
      console.log('✨ Todo actualizado, no hay migraciones pendientes.');
    } else {
      console.log(`\n🎉 ${executed} migración(es) ejecutada(s) exitosamente.`);
    }

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌ Error en migración:', err.message);
    console.error(err.detail || '');
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();