import { beforeAll, expect, test } from 'vitest';
import { databaseFixture, createConnectionResolver } from '../helpers/database-mode.js';
import { applyMigrations } from '../helpers/migrations.js';
import { seedTenantRows } from '../fixtures/tenant-rows.js';
import { resolveUnmatchedQuery } from '../../src/features/understanding/understanding.service.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000101';
const resolveConnection = createConnectionResolver(pool);

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
  await pool.query('TRUNCATE threads CASCADE');
  await pool.query('DELETE FROM orphans');
  await pool.query("UPDATE units SET text = 'udah??', triage_class = 'QUERY'");
}, 120000);

test('REG-002 / SRS T-04: udah?? with no candidate yields one orphan and zero threads', async () => {
  await resolveUnmatchedQuery(resolveConnection, { workspaceId, unitId: workspaceId });
  await resolveUnmatchedQuery(resolveConnection, { workspaceId, unitId: workspaceId });
  const orphans = await pool.query('SELECT reason FROM orphans WHERE unit_id = $1', [workspaceId]);
  const threads = await pool.query('SELECT count(*)::int AS count FROM threads');

  expect(orphans.rows).toEqual([{ reason: 'G1' }]);
  expect(threads.rows[0].count).toBe(0);
});
