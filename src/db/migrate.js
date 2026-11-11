import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  const schemaPath = path.resolve(__dirname, '../../sql/001_schema.sql');
  console.log(`[db:migrate] Applying schema from ${schemaPath}...`);

  const client = await pool.connect();
  try {
    const sql = await fs.readFile(schemaPath, 'utf8');
    await client.query(sql);
    console.log('[db:migrate] Database schema applied successfully.');
  } catch (err) {
    console.error('[db:migrate] Failed to apply database schema:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
