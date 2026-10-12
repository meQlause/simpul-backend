import { beforeAll, expect, test, vi } from 'vitest';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { scopedTransaction } from '../../../../src/platform/db/scoped-transaction.js';
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

test('SRS §11.6: a rejected RLS write emits one failure without driver text', async () => {
  const emit = vi.fn();
  const resolve = Object.assign(createConnectionResolver(pool), { emit });
  const client = await pool.connect();

  await client.query('SET ROLE test_app');
  client.release();

  try {
    await expect(
      scopedTransaction(resolve, workspaceId, (tx) =>
        tx.query("INSERT INTO people (workspace_id, name) VALUES ($1, 'private-person-name')", [
          '00000000-0000-4000-8000-000000000003',
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(emit.mock.calls).toEqual([
      [{ name: 'rls_failure', kind: 'delta', value: 1, workspaceId }],
    ]);
  } finally {
    await pool.query('RESET ROLE');
  }
});

test('SRS §11.6: an ordinary privilege denial does not inflate the RLS failure metric', async () => {
  await pool.query('CREATE ROLE denied_reader NOLOGIN NOSUPERUSER NOBYPASSRLS');
  await pool.query('GRANT USAGE ON SCHEMA public TO denied_reader');
  const emit = vi.fn();
  const resolve = Object.assign(createConnectionResolver(pool), { emit });

  await pool.query('SET ROLE denied_reader');

  try {
    await expect(
      scopedTransaction(resolve, workspaceId, (tx) => tx.query('SELECT * FROM people')),
    ).rejects.toMatchObject({ code: '42501' });
    expect(emit).not.toHaveBeenCalled();
  } finally {
    await pool.query('RESET ROLE');
  }
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
