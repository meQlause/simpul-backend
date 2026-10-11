import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { resolveCandidates } from '../../../../src/features/understanding/understanding.resolve.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000101';
const ids = [
  workspaceId,
  '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000103',
];
const publishComprehend = vi.fn();
const dependencies = { resolveConnection: createConnectionResolver(pool), publishComprehend };
const scope = { workspaceId, unitId: workspaceId };
const candidates = ids.map((id, index) => ({
  id,
  score: [0.6, 0.54, 0.52][index],
  quantity: null,
}));
const now = new Date('2026-10-10T04:01:00Z');

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
  await pool.query(
    "INSERT INTO threads (id, workspace_id, display_id, status, domain_id, channel_id, summary, genesis_confidence) SELECT x.id, $1, x.display_id, 'active', $1, $1, 'Candidate', 0.9 FROM (VALUES ($2::uuid, 'ORD-0002'), ($3::uuid, 'ORD-0003')) x(id, display_id)",
    ids,
  );
}, 120000);

beforeEach(async () => {
  await pool.query('DELETE FROM open_questions');
  await pool.query('DELETE FROM orphans');
  publishComprehend.mockClear();
});

test('SRS T-07: three near-equal candidates produce an open question, and the model is not asked to choose', async () => {
  await resolveCandidates(dependencies, scope, { candidates, quantity: null }, now);
  await resolveCandidates(dependencies, scope, { candidates, quantity: null }, now);
  const questions = await pool.query('SELECT thread_ids, asked_at, expires_at FROM open_questions');

  expect(questions.rows).toEqual([
    { thread_ids: ids, asked_at: now, expires_at: new Date(now.getTime() + 600000) },
  ]);
  expect(publishComprehend).not.toHaveBeenCalled();
});

test('SRS §8.4: an exhausted question quota creates an orphan and no model choice', async () => {
  await pool.query(
    "INSERT INTO thresholds (workspace_id, key, value) VALUES ($1, 'questions_per_channel_per_day', 0) ON CONFLICT ON CONSTRAINT thresholds_uq DO UPDATE SET value = 0",
    [workspaceId],
  );
  await resolveCandidates(dependencies, scope, { candidates, quantity: null }, now);
  const questions = await pool.query('SELECT count(*)::int AS count FROM open_questions');
  const orphans = await pool.query('SELECT count(*)::int AS count FROM orphans');

  expect(questions.rows[0].count).toBe(0);
  expect(orphans.rows[0].count).toBe(1);
  expect(publishComprehend).not.toHaveBeenCalled();
});
