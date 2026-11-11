import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runSeed() {
  const seedPath = path.resolve(__dirname, '../../sql/002_seed.sql');
  console.log(`[db:seed] Running seed script from ${seedPath}...`);

  const client = await pool.connect();
  try {
    const sql = await fs.readFile(seedPath, 'utf8');
    await client.query(sql);
    console.log('[db:seed] Database seed completed successfully.');
  } catch (err) {
    console.error('[db:seed] Failed to seed database:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runSeed();
