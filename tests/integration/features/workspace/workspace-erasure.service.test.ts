import { beforeAll, afterAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations, scopedTableNames } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { createQueue } from '../../../../src/platform/queue/index.js';
import { eraseWorkspace } from '../../../../src/features/workspace/workspace-erasure.service.js';
import { registerErasureJobs } from '../../../../src/features/workspace/workspace-erasure.jobs.js';

const pool = databaseFixture();
const workspaceId = randomUUID();
const foreignId = randomUUID();
const resolver = createConnectionResolver(pool);
let queue: PgBoss;
let tables: string[];

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
  await seedTenantRows(pool, foreignId);
  tables = await scopedTableNames(pool);
  queue = await createQueue(pool);

  for (const id of [workspaceId, foreignId]) {
    await pool.query('UPDATE workspaces SET admin_person_id = $1 WHERE id = $1', [id]);
    await pool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'Admin', $1 || '@example.test', true)`,
      [id],
    );
    await pool.query(
      `INSERT INTO "account" (id, "accountId", "providerId", "userId", "updatedAt") VALUES ($1, $1, 'credential', $1, now())`,
      [id],
    );
    await pool.query(
      `INSERT INTO "session" (id, token, "userId", "expiresAt", "updatedAt") VALUES ($1, $1, $1, now() + interval '1 day', now())`,
      [id],
    );
    await pool.query(
      `INSERT INTO verification (id, identifier, value, "expiresAt") VALUES ($1, 'reset-password:' || $1, $1, now() + interval '1 day')`,
      [id],
    );
    await queue.send('delivery.staleness', { workspaceId: id });
  }
}, 30000);
afterAll(async () => {
  await queue?.stop();
});

async function snapshot(id: string) {
  const rows: Record<string, unknown> = {};

  for (const table of tables) {
    rows[table] = (
      await pool.query(
        `SELECT to_jsonb(record) AS data FROM "${table}" record WHERE workspace_id = $1 ORDER BY to_jsonb(record)::text`,
        [id],
      )
    ).rows;
  }

  rows.workspaces = (await pool.query('SELECT * FROM workspaces WHERE id = $1', [id])).rows;
  rows.auth = (await pool.query('SELECT id FROM "user" WHERE id = $1', [id])).rows;
  rows.jobs = (
    await pool.query(
      "SELECT id, data FROM pgboss.job WHERE data->>'workspaceId' = $1 ORDER BY id",
      [id],
    )
  ).rows;

  return rows;
}

test('Data-spec R-12: an unprivileged RLS role cannot erase a workspace without seeing foreign dependencies', async () => {
  await pool.query('CREATE ROLE erasure_app NOLOGIN NOSUPERUSER NOBYPASSRLS');
  await pool.query('GRANT USAGE ON SCHEMA public TO erasure_app');
  await pool.query('GRANT SELECT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erasure_app');
  await pool.query('SET ROLE erasure_app');

  try {
    await expect(eraseWorkspace(resolver, workspaceId)).rejects.toMatchObject({
      code: 'E-FORBIDDEN',
    });
  } finally {
    await pool.query('RESET ROLE');
  }

  expect(
    (await pool.query('SELECT id FROM workspaces WHERE id = $1', [workspaceId])).rows,
  ).toHaveLength(1);
});

test('Data-spec R-12: a new workspace table blocks erasure until its deletion order is reviewed', async () => {
  await pool.query('CREATE TABLE erasure_future_table (workspace_id uuid NOT NULL)');

  try {
    await expect(eraseWorkspace(resolver, workspaceId)).rejects.toMatchObject({
      code: 'E-FORBIDDEN',
    });
    expect(
      (await pool.query('SELECT id FROM workspaces WHERE id = $1', [workspaceId])).rows,
    ).toHaveLength(1);
  } finally {
    await pool.query('DROP TABLE erasure_future_table');
  }
});

test('Data-spec R-12: a foreign reference blocks erasure atomically rather than cascading a change into another workspace', async () => {
  await pool.query('UPDATE people SET manager_id = $1 WHERE workspace_id = $2', [
    workspaceId,
    foreignId,
  ]);
  const before = await snapshot(foreignId);

  await expect(eraseWorkspace(resolver, workspaceId)).rejects.toMatchObject({
    code: 'E-FORBIDDEN',
  });
  expect(await snapshot(foreignId)).toEqual(before);
  expect(
    (await pool.query('SELECT id FROM workspaces WHERE id = $1', [workspaceId])).rows,
  ).toHaveLength(1);
  await pool.query('UPDATE people SET manager_id = NULL WHERE workspace_id = $1', [foreignId]);
});

test('Data-spec R-12: erasure removes one workspace from every scoped table, auth and queued jobs without changing another workspace', async () => {
  const before = await snapshot(foreignId);

  expect(await eraseWorkspace(resolver, workspaceId)).toBe(true);
  const after = await snapshot(workspaceId);

  expect(Object.values(after).every((rows) => Array.isArray(rows) && rows.length === 0)).toBe(true);
  expect(await snapshot(foreignId)).toEqual(before);

  for (const table of ['account', 'session', 'verification']) {
    expect(
      (await pool.query(`SELECT id FROM "${table}" WHERE id = $1`, [workspaceId])).rows,
    ).toEqual([]);
    expect(
      (await pool.query(`SELECT id FROM "${table}" WHERE id = $1`, [foreignId])).rows,
    ).toHaveLength(1);
  }

  expect(await eraseWorkspace(resolver, workspaceId)).toBe(false);
});

test('Data-spec R-12: the live workspace.erase worker erases its scoped workspace', async () => {
  const id = randomUUID();

  await seedTenantRows(pool, id);
  await registerErasureJobs(queue, resolver);
  await queue.send('workspace.erase', { workspaceId: id });
  await expect
    .poll(
      async () => (await pool.query('SELECT id FROM workspaces WHERE id = $1', [id])).rowCount,
      { timeout: 10000 },
    )
    .toBe(0);
  expect(
    Object.values(await snapshot(id)).every((rows) => Array.isArray(rows) && rows.length === 0),
  ).toBe(true);
});
