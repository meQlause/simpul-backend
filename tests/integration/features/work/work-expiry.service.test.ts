import { beforeAll, expect, test } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { createFromGenesis, expireTentative } from '../../../../src/features/work/index.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000201';
const foreignId = '00000000-0000-4000-8000-000000000202';
const resolveConnection = createConnectionResolver(pool);
const now = new Date('2026-10-10T04:01:00Z');
let expiredId: string;
let boundaryId: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
  await seedTenantRows(pool, foreignId);
  await pool.query('UPDATE display_id_counters SET last_value = 1');
  expiredId = await tentative(workspaceId);
  boundaryId = await tentative(workspaceId);
  await tentative(workspaceId);
  const foreign = await tentative(foreignId);

  await pool.query(
    "UPDATE threads SET expires_at = $1::timestamptz - interval '1 second' WHERE id = ANY($2::uuid[])",
    [now, [expiredId, foreign]],
  );
  await pool.query('UPDATE threads SET expires_at = $1 WHERE id = $2', [now, boundaryId]);
  await pool.query(
    "INSERT INTO message_thread_link (workspace_id, message_id, thread_id, role, confidence) VALUES ($1, $1, $2, 'genesis', 1)",
    [workspaceId, expiredId],
  );
  await pool.query(
    "INSERT INTO progress_markers (workspace_id, thread_id, ts, text, type) VALUES ($1, $2, $3, 'Tentative evidence', 'progress')",
    [workspaceId, expiredId, now],
  );
});

async function tentative(id: string) {
  const item = await createFromGenesis(
    resolveConnection,
    id,
    { domainId: id, channelId: id, summary: 'Tentative order', confidence: 0.55 },
    now,
  );

  if (!item) {
    throw new Error('Expected tentative fixture');
  }

  return item.id;
}

test('A tentative item past expiresAt is deleted with its links and markers, leaving no decision row', async () => {
  const decisionsBefore = await pool.query('SELECT id FROM decisions ORDER BY id');

  expect(await expireTentative(resolveConnection, workspaceId, now)).toBe(2);
  expect(
    (
      await pool.query('SELECT id FROM threads WHERE id = ANY($1::uuid[])', [
        [expiredId, boundaryId],
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await pool.query('SELECT thread_id FROM message_thread_link WHERE thread_id = $1', [
        expiredId,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (await pool.query('SELECT thread_id FROM progress_markers WHERE thread_id = $1', [expiredId]))
      .rows,
  ).toEqual([]);
  expect((await pool.query('SELECT id FROM decisions ORDER BY id')).rows).toEqual(
    decisionsBefore.rows,
  );
});
test('Expiry leaves future tentative, active and foreign items alone and retains allocated counters', async () => {
  const { rows } = await pool.query(
    'SELECT workspace_id, status FROM threads ORDER BY workspace_id, status',
  );

  expect(rows).toEqual([
    { workspace_id: workspaceId, status: 'active' },
    { workspace_id: workspaceId, status: 'tentative' },
    { workspace_id: foreignId, status: 'active' },
    { workspace_id: foreignId, status: 'tentative' },
  ]);
  expect(
    (
      await pool.query('SELECT last_value FROM display_id_counters WHERE domain_id = $1', [
        workspaceId,
      ])
    ).rows[0].last_value,
  ).toBe(4);
  expect(await expireTentative(resolveConnection, workspaceId, now)).toBe(0);
});
