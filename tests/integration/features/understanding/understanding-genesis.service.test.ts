import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import type { ModelPort } from '../../../../src/platform/llm/port.js';
import { comprehendGenesisUnit } from '../../../../src/features/understanding/understanding-genesis.service.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000301';
const scope = { workspaceId, unitId: workspaceId };

type Request = Parameters<ModelPort['generate']>[0];
const generate = vi.fn<ModelPort['generate']>();
const services = {
  resolveConnection: createConnectionResolver(pool),
  model: { generate },
  now: () => new Date('2026-10-13T09:30:00Z'),
  alert: vi.fn(),
};

// What the model answers for a first message about new work: the genesis cites its own source
// messages, and there is nothing to progress, resolve or block yet.
function newOrder(request: Request, operations: unknown[] = []) {
  return JSON.stringify({
    genesis: {
      domainId: request.context?.categories?.[0]?.id,
      intent: 'work_event',
      tense: 'sudah_terjadi',
      who: 'Toko Berkah',
      what: 'Indomie 12 dus',
      action: 'pesanan dikonfirmasi',
      completionCondition: 'Pesanan dikirim',
      summary: 'New order from Toko Berkah',
      confidence: 0.9,
      evidenceMessageIds: request.context?.evidenceMessageIds,
    },
    operations,
  });
}

const created = async () =>
  (
    await pool.query('SELECT count(*)::int AS n FROM threads WHERE workspace_id = $1', [
      workspaceId,
    ])
  ).rows[0].n as number;

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
  // The fixture's own work item holds the first display id; new work numbers after it.
  await pool.query('UPDATE display_id_counters SET last_value = 100 WHERE workspace_id = $1', [
    workspaceId,
  ]);
}, 120000);

beforeEach(async () => {
  vi.resetAllMocks();
  await pool.query('TRUNCATE labels CASCADE');
  await pool.query('DELETE FROM orphans');
});

test('SRS §7.3: a genesis that passes G1–G5 creates work even with no operations', async () => {
  const before = await created();

  generate.mockImplementation(async (request) => newOrder(request));
  await comprehendGenesisUnit(services, scope);

  expect(generate).toHaveBeenCalledOnce();
  expect((await pool.query('SELECT reason FROM orphans')).rows).toEqual([]);
  expect(await created()).toBe(before + 1);
});

test('SRS §7.2: an operation without evidence is discarded, the genesis still creates work', async () => {
  const before = await created();
  const unsupported = {
    type: 'progress',
    tense: 'sudah_terjadi',
    confidence: 0.9,
    evidenceMessageIds: [],
  };

  generate.mockImplementation(async (request) => newOrder(request, [unsupported]));
  await comprehendGenesisUnit(services, scope);

  expect((await pool.query('SELECT reason FROM orphans')).rows).toEqual([]);
  expect(await created()).toBe(before + 1);
  expect(
    (await pool.query('SELECT * FROM labels WHERE workspace_id = $1', [workspaceId])).rowCount,
  ).toBe(0);
});
