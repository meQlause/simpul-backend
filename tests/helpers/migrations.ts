import { globSync, readFileSync } from 'node:fs';
import type { Pool } from 'pg';

export async function applyMigrations(pool: Pool) {
  for (const migration of globSync('drizzle/*.sql').sort()) {
    await pool.query(readFileSync(migration, 'utf8'));
  }
}

export async function scopedTableNames(pool: Pool) {
  const result = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'workspace_id' ORDER BY table_name",
  );
  return result.rows.map(({ table_name }) => table_name);
}
