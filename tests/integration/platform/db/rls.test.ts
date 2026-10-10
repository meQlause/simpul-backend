import { beforeAll, expect, test } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations, scopedTableNames } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000002';

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
  await pool.query('CREATE ROLE test_app NOLOGIN NOSUPERUSER NOBYPASSRLS');
  await pool.query('GRANT USAGE ON SCHEMA public TO test_app');
  await pool.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO test_app',
  );
});

test('A query run outside the scoped transaction returns zero rows from every table that has workspace_id', async () => {
  const tables = await scopedTableNames(pool);
  expect(tables.length).toBeGreaterThan(0);
  for (const table of tables) {
    expect(
      (await pool.query(`SELECT * FROM "${table}"`)).rowCount,
      `${table} must be populated`,
    ).toBe(1);
  }
  const client = await pool.connect();
  try {
    await client.query('SET ROLE test_app');
    for (const table of tables) {
      expect((await client.query(`SELECT * FROM "${table}"`)).rows, table).toEqual([]);
    }
  } finally {
    await client.query('RESET ROLE');
    client.release();
  }
});
