/**
 * npm run migrate —— 执行 db/schema.sql（幂等，可重复执行）。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

async function main(): Promise<void> {
  const schemaPath = fileURLToPath(new URL('../../db/schema.sql', import.meta.url));
  const sql = await readFile(schemaPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    console.log(`migrate: ${schemaPath} applied`);
    console.log(`migrate: ${rows.length} tables in public`);
    for (const r of rows) console.log(`  - ${r.table_name}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('migrate failed:', err);
  process.exit(1);
});
