import { beforeAll, beforeEach, expect, test } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { storeComprehension } from '../../../../src/features/understanding/understanding.service.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000101';
const resolveConnection = createConnectionResolver(pool);
const scope = { workspaceId, unitId: workspaceId, threadId: workspaceId };
const operation = {
  type: 'progress',
  tense: 'sudah_terjadi',
  confidence: 0.9,
  evidenceMessageIds: [workspaceId],
};

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
}, 120000);

beforeEach(async () => {
  await pool.query('TRUNCATE labels CASCADE');
  await pool.query('DELETE FROM orphans');
});

test('SRS T-08: a model operation with empty evidence is discarded', async () => {
  await storeComprehension(resolveConnection, scope, {
    operations: [{ ...operation, evidenceMessageIds: [] }],
  });
  const labels = await pool.query('SELECT count(*)::int AS count FROM labels');
  const orphans = await pool.query(
    'SELECT count(*)::int AS count FROM orphans WHERE unit_id = $1',
    [workspaceId],
  );

  expect(labels.rows[0].count).toBe(0);
  expect(orphans.rows[0].count).toBe(1);
});

test('SRS §7.2: valid operations survive an empty-evidence operation in the same response', async () => {
  await storeComprehension(resolveConnection, scope, {
    operations: [{ ...operation, evidenceMessageIds: [] }, operation],
  });
  await storeComprehension(resolveConnection, scope, { operations: [operation] });
  const labels = await pool.query('SELECT evidence_message_ids FROM labels');

  expect(labels.rows).toEqual([{ evidence_message_ids: [workspaceId] }]);
});
