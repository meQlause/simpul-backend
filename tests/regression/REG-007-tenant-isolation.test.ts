import type { PoolClient } from 'pg';
import { beforeAll, expect, test } from 'vitest';
import { createConnectionResolver } from '../../src/platform/db/connection-resolver.js';
import { scopedTransaction } from '../../src/platform/db/scoped-transaction.js';
import { databaseFixture } from '../helpers/database.js';
import { applyMigrations, scopedTableNames } from '../helpers/migrations.js';
import { seedTenantRows } from '../fixtures/tenant-rows.js';

const pool = databaseFixture();
const workspaceA = '00000000-0000-4000-8000-000000000003';
const workspaceB = '00000000-0000-4000-8000-000000000004';
const resolveConnection = createConnectionResolver(pool);

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceA);
  await seedTenantRows(pool, workspaceB);
  await pool.query('CREATE ROLE test_app NOLOGIN NOSUPERUSER NOBYPASSRLS');
  await pool.query('GRANT USAGE ON SCHEMA public TO test_app');
  await pool.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO test_app',
  );
  await pool.query('SET ROLE test_app');
});

async function foreignRow(table: string) {
  const admin = await pool.connect();

  try {
    await admin.query('RESET ROLE');
    const result = await admin.query(
      `SELECT row_to_json(record) AS snapshot FROM "${table}" AS record WHERE workspace_id = $1`,
      [workspaceB],
    );

    return result.rows[0].snapshot;
  } finally {
    await admin.query('SET ROLE test_app');
    admin.release();
  }
}

async function rejectForeignInsert(tx: PoolClient, table: string, snapshot: unknown) {
  await tx.query('SAVEPOINT foreign_insert');
  await expect(
    tx.query(
      `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`,
      [JSON.stringify(snapshot)],
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await tx.query('ROLLBACK TO SAVEPOINT foreign_insert');
  await tx.query('RELEASE SAVEPOINT foreign_insert');
}

test('REG-007: With two seeded workspaces, a scoped transaction for A reads and writes no row of B, in every table', async () => {
  const tables = await scopedTableNames(pool);

  expect(tables.length).toBeGreaterThan(0);

  for (const table of tables) {
    const original = await foreignRow(table);

    await scopedTransaction(resolveConnection, workspaceA, async (tx) => {
      const result = await tx.query(`SELECT workspace_id FROM "${table}"`);

      expect(result.rows, table).toEqual([{ workspace_id: workspaceA }]);
      expect(
        (
          await tx.query(
            `UPDATE "${table}" SET workspace_id = workspace_id WHERE workspace_id = $1`,
            [workspaceB],
          )
        ).rowCount,
        table,
      ).toBe(0);
      expect(
        (await tx.query(`DELETE FROM "${table}" WHERE workspace_id = $1`, [workspaceB])).rowCount,
        table,
      ).toBe(0);
      await rejectForeignInsert(tx, table, original);
    });
    expect(await foreignRow(table), table).toEqual(original);
  }
});

test('The transaction scope is local: returning a connection to the pool exposes no tenant rows', async () => {
  await scopedTransaction(resolveConnection, workspaceA, (tx) => tx.query('SELECT id FROM people'));
  expect((await pool.query('SELECT id FROM people')).rows).toEqual([]);
  await scopedTransaction(resolveConnection, workspaceB, async (tx) => {
    expect((await tx.query('SELECT workspace_id FROM people')).rows).toEqual([
      { workspace_id: workspaceB },
    ]);
  });
});

test('A failed operation rolls back its changes and clears its workspace scope', async () => {
  const failure = new Error('Test operation failed');

  await expect(
    scopedTransaction(resolveConnection, workspaceA, async (tx) => {
      await tx.query("UPDATE people SET name = 'Changed' WHERE workspace_id = $1", [workspaceA]);
      throw failure;
    }),
  ).rejects.toBe(failure);
  await scopedTransaction(resolveConnection, workspaceA, async (tx) => {
    expect((await tx.query('SELECT name FROM people')).rows).toEqual([{ name: 'Test operator' }]);
  });
  expect((await pool.query('SELECT id FROM people')).rows).toEqual([]);
});
