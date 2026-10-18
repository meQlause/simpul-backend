import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { registerSchedulerJobs } from '../../../../src/roles/scheduler.js';
import { createQueue } from '../../../../src/platform/queue/index.js';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';

// One snapshot refreshes every queue's statistics in turn through a one-connection pool: about
// 3.5 s alone, so the 5 s default is too tight under a parallel run. No assertion is relaxed.
vi.setConfig({ testTimeout: 20000 });

const pool = databaseFixture();
const seed = pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') });
const emit = vi.fn();
const callbacks = new Map<string, () => Promise<void>>();
let boss: PgBoss;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
  await pool.query(
    "INSERT INTO workspaces (id, name, timezone) VALUES ($1, 'Empty workspace', 'Asia/Jakarta')",
    ['00000000-0000-4000-8000-000000100002'],
  );
  await pool.query(
    `UPDATE notifications SET sent_at = $2 WHERE workspace_id = $1 AND channel = 'email'
      AND label_id = md5('point-star-label-1')::uuid`,
    [seed.workspaceId, seed.now],
  );
  await pool.query(
    `INSERT INTO corrections (workspace_id, op_id, notification_id, corrected_by,
      correction_type, previous_state, created_at)
    SELECT $1, label.op_id, notification.id, md5('point-star-person-2')::uuid,
      'not_this_work', '{}', $2
    FROM notifications notification JOIN labels label ON label.id = notification.label_id
    WHERE notification.workspace_id = $1 AND notification.channel = 'telegram'
      AND notification.kind = 'update' AND label.id = md5('point-star-label-1')::uuid`,
    [seed.workspaceId, seed.now],
  );
  boss = await createQueue(pool);
  await boss.send('understanding.triage', { workspaceId: seed.workspaceId });
  await boss.send('understanding.triage', { workspaceId: seed.workspaceId }, { startAfter: 3600 });
  const queue = {
    work: async (name: string, callback: () => Promise<void>) => callbacks.set(name, callback),
    schedule: vi.fn(),
    getQueues: () => boss.getQueues(),
    getQueueStats: (name: string, options: { force: boolean }) => boss.getQueueStats(name, options),
  };

  await registerSchedulerJobs(queue as unknown as PgBoss, pool, undefined, {
    emit,
    now: () => seed.now,
  });
  await pool.query('CREATE ROLE metrics_reader NOLOGIN NOSUPERUSER NOBYPASSRLS');
  await pool.query('GRANT USAGE ON SCHEMA public, pgboss TO metrics_reader');
  await pool.query('GRANT SELECT ON ALL TABLES IN SCHEMA public, pgboss TO metrics_reader');
  await pool.query('GRANT UPDATE ON pgboss.queue TO metrics_reader');
  await pool.query('GRANT EXECUTE ON FUNCTION scheduled_workspaces() TO metrics_reader');
}, 120000);
afterAll(async () => {
  await boss?.stop();
});

test('SRS §11.6: the restricted scheduler reports scoped metrics and zero denominators without exposing other tenant rows', async () => {
  emit.mockClear();
  await pool.query('SET ROLE metrics_reader');

  try {
    expect((await pool.query('SELECT * FROM messages_raw')).rows).toEqual([]);
    await callbacks.get('metrics.snapshot')?.();
    expect(emit).toHaveBeenCalledWith({
      name: 'correction_rate',
      kind: 'gauge',
      value: 1 / 983,
      numerator: 1,
      denominator: 983,
      workspaceId: seed.workspaceId,
      windowSeconds: 30 * 24 * 60 * 60,
    });
    expect(emit).toHaveBeenCalledWith({
      name: 'unclaimed_density',
      kind: 'gauge',
      value: 0,
      numerator: 0,
      denominator: 0,
      workspaceId: '00000000-0000-4000-8000-000000100002',
      windowSeconds: 24 * 60 * 60,
    });
    expect(emit.mock.calls.map(([metric]) => metric.name)).not.toContain(
      'metrics_collection_failure',
    );
  } finally {
    await pool.query('RESET ROLE');
  }
});

test('SRS §11.6: scheduled metric logs report fresh queue depth and distinct-operation correction and unclaimed ratios', async () => {
  expect(callbacks.has('metrics.snapshot')).toBe(true);
  await callbacks.get('metrics.snapshot')?.();
  expect(emit).toHaveBeenCalledWith({
    name: 'queue_depth',
    kind: 'gauge',
    value: 2,
    stage: 'understanding.triage',
    databaseId: 'hosted',
    sampledAt: expect.any(String),
  });
  expect(emit).toHaveBeenCalledWith({
    name: 'correction_rate',
    kind: 'gauge',
    value: 1 / 983,
    numerator: 1,
    denominator: 983,
    workspaceId: seed.workspaceId,
    windowSeconds: 30 * 24 * 60 * 60,
  });
  expect(emit).toHaveBeenCalledWith({
    name: 'unclaimed_density',
    kind: 'gauge',
    value: 2358 / 2422,
    numerator: 2358,
    denominator: 2422,
    workspaceId: seed.workspaceId,
    windowSeconds: 24 * 60 * 60,
  });
  expect(JSON.stringify(emit.mock.calls)).not.toContain('Sample order update');
});

test('SRS §11.6: a failed collection emits a failure event rather than zero rate samples or driver text', async () => {
  emit.mockClear();
  await pool.query('REVOKE EXECUTE ON FUNCTION scheduled_workspaces() FROM metrics_reader');
  await pool.query('SET ROLE metrics_reader');

  try {
    await callbacks.get('metrics.snapshot')?.();
    expect(emit).toHaveBeenCalledWith({
      name: 'metrics_collection_failure',
      kind: 'delta',
      value: 1,
      databaseId: 'hosted',
    });
    expect(emit.mock.calls.map(([metric]) => metric.name)).not.toContain('correction_rate');
    expect(JSON.stringify(emit.mock.calls)).not.toContain('permission denied');
  } finally {
    await pool.query('RESET ROLE');
    await pool.query('GRANT EXECUTE ON FUNCTION scheduled_workspaces() TO metrics_reader');
  }
});
