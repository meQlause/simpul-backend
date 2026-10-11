import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { comprehendUnit } from '../../../../src/features/understanding/understanding.comprehension.js';
import { createQueue, publishResolution } from '../../../../src/platform/queue/index.js';
import { replayModelFailure } from '../../../../src/features/understanding/understanding.replay.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000101';
const scope = { workspaceId, unitId: workspaceId, threadId: workspaceId };
const generate = vi.fn<(...args: unknown[]) => Promise<string>>();
const alert = vi.fn();
const dependencies = {
  resolveConnection: createConnectionResolver(pool),
  model: { generate },
  alert,
};
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
  vi.resetAllMocks();
  await pool.query('TRUNCATE labels CASCADE');
  await pool.query('DELETE FROM orphans');
});

test('SRS §12.1: invalid model JSON retries once at temperature 0; neither attempt produces a label', async () => {
  generate.mockResolvedValue('{invalid');
  await comprehendUnit(dependencies, scope);
  await comprehendUnit(dependencies, scope);

  expect(generate).toHaveBeenCalledTimes(2);
  expect(generate.mock.calls[1]?.[0]).toMatchObject({ temperature: 0 });
  expect((await pool.query('SELECT * FROM labels')).rowCount).toBe(0);
  expect((await pool.query('SELECT reason FROM orphans')).rows).toEqual([
    { reason: 'model_invalid_json' },
  ]);
  expect(alert).toHaveBeenCalledExactlyOnceWith({ ...scope, reason: 'model_invalid_json' });
  expect((await pool.query('SELECT * FROM review_items')).rowCount).toBe(0);
});

test('SRS §12.1: schema-invalid JSON takes the same bounded retry', async () => {
  generate
    .mockResolvedValueOnce(JSON.stringify({ recipients: ['admin'] }))
    .mockResolvedValueOnce(JSON.stringify({ operations: [operation] }));
  await comprehendUnit(dependencies, scope);

  expect(generate).toHaveBeenCalledTimes(2);
  expect((await pool.query('SELECT * FROM labels')).rowCount).toBe(1);
  expect((await pool.query('SELECT * FROM orphans')).rowCount).toBe(0);
  expect(alert).not.toHaveBeenCalled();
});

test('SRS §12.1: a 429 is propagated for queue backoff, without labels or manual orphans', async () => {
  const rateLimit = Object.assign(new Error('rate limited'), { status: 429 });

  generate.mockRejectedValue(rateLimit);

  await expect(comprehendUnit(dependencies, scope)).rejects.toBe(rateLimit);
  expect(generate).toHaveBeenCalledTimes(1);
  expect((await pool.query('SELECT * FROM labels')).rowCount).toBe(0);
  expect((await pool.query('SELECT * FROM orphans')).rowCount).toBe(0);
  expect(alert).not.toHaveBeenCalled();
});

test('SRS §12.1: pg-boss retains a rate-limited attempt for backoff', async () => {
  const boss = await createQueue(pool);

  try {
    await boss.createQueue('understanding.comprehend', { retryLimit: 5, retryBackoff: true });
    const id = await boss.send('understanding.comprehend', { workspaceId, unitId: workspaceId });
    const [job] = await boss.fetch('understanding.comprehend');
    const rateLimit = Object.assign(new Error('rate limited'), { status: 429 });

    generate.mockRejectedValue(rateLimit);

    await expect(comprehendUnit(dependencies, scope)).rejects.toBe(rateLimit);
    await boss.fail('understanding.comprehend', job!, rateLimit);
    const retained = await boss.getJobById('understanding.comprehend', id!);

    expect(retained).toMatchObject({ state: 'retry', data: { workspaceId, unitId: workspaceId } });
    expect((await pool.query('SELECT * FROM labels')).rowCount).toBe(0);
  } finally {
    await boss.stop();
  }
});

test('B6 operator decision: replay clears only a model failure and atomically republishes its ids', async () => {
  generate.mockResolvedValue('{invalid');
  await comprehendUnit(dependencies, scope);
  const boss = await createQueue(pool);
  const publishResolve = vi.fn(publishResolution(boss));
  const replay = { resolveConnection: dependencies.resolveConnection, publishResolve };
  const payload = { workspaceId, unitId: workspaceId };

  expect(await replayModelFailure(replay, payload)).toBe(true);
  expect(await replayModelFailure(replay, payload)).toBe(false);
  expect(publishResolve).toHaveBeenCalledExactlyOnceWith(expect.anything(), payload);
  expect((await pool.query('SELECT * FROM orphans')).rowCount).toBe(0);
  const [job] = await boss.fetch('understanding.resolve');

  expect(job?.data).toEqual(payload);
  await boss.stop();
});

test('B6 operator decision: a failed replay publish preserves the persisted orphan', async () => {
  generate.mockResolvedValue('{invalid');
  await comprehendUnit(dependencies, scope);
  const publishResolve = vi.fn(async () => {
    throw new Error('queue unavailable');
  });

  await expect(
    replayModelFailure(
      { resolveConnection: dependencies.resolveConnection, publishResolve },
      { workspaceId, unitId: workspaceId },
    ),
  ).rejects.toThrow('queue unavailable');
  expect((await pool.query('SELECT reason FROM orphans')).rows).toEqual([
    { reason: 'model_invalid_json' },
  ]);
});
