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

test('SRS §7.3: a genesis that passes G1–G5 creates work even with no operations, and its message gets one progress label', async () => {
  const before = await created();

  generate.mockImplementation(async (request) => newOrder(request));
  await comprehendGenesisUnit(services, scope);

  expect(generate).toHaveBeenCalledOnce();
  expect((await pool.query('SELECT reason FROM orphans')).rows).toEqual([]);
  expect(await created()).toBe(before + 1);
  expect(
    (await pool.query('SELECT type, tense FROM labels WHERE workspace_id = $1', [workspaceId]))
      .rows,
  ).toEqual([{ type: 'progress', tense: 'sudah_terjadi' }]);
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
  // Only the genesis label remains: the discarded operation adds none of its own.
  expect(
    (await pool.query('SELECT type FROM labels WHERE workspace_id = $1', [workspaceId])).rows,
  ).toEqual([{ type: 'progress' }]);
});

let sequence = 0;

async function insertMessage(bodySafe: string, serverTs: Date) {
  sequence += 1;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages_raw (workspace_id, channel_id, provider_msg_id, sender_external_id, body, body_safe, server_ts, received_ts, origin)
     VALUES ($1, $1, $2, 'sender', 'private raw text', $3, $4, $4, 'user') RETURNING id`,
    [workspaceId, `genesis-${sequence}`, bodySafe, serverTs],
  );

  return rows[0].id;
}

async function insertUnit(messageIds: string[], tsFirst: Date) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO units (workspace_id, channel_id, sender_id, text, triage_class, ts_first, ts_last)
     VALUES ($1, $1, $1, 'unit', 'EVENT', $2, $2) RETURNING id`,
    [workspaceId, tsFirst],
  );

  for (const messageId of messageIds) {
    await pool.query(
      'INSERT INTO unit_messages (workspace_id, unit_id, message_id) VALUES ($1, $2, $3)',
      [workspaceId, rows[0].id, messageId],
    );
  }

  return rows[0].id;
}

// A confirmed order that cites the unit's own message unless the case overrides it.
function answer(request: Request, override: Record<string, unknown> = {}) {
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
      ...override,
    },
    operations: [],
  });
}

const reasons = async (unitId: string) =>
  (await pool.query('SELECT reason FROM orphans WHERE unit_id = $1', [unitId])).rows;

test('SRS §7.3 (FR-RES-01, T-32): a genesis reads the earlier messages of its channel as context, oldest first', async () => {
  const when = new Date('2026-10-13T11:00:00Z');
  const first = await insertMessage(
    'ada pesanan baru toko berkah',
    new Date(when.getTime() - 2 * 60000),
  );
  const second = await insertMessage('sudah ada 12 biji', new Date(when.getTime() - 60000));
  const own = await insertMessage('uda di konfirm ya ternyata 12 biji', when);
  const unitId = await insertUnit([own], when);
  const before = await created();

  generate.mockImplementation(async (request) => answer(request));

  await comprehendGenesisUnit(services, { workspaceId, unitId });

  expect(generate.mock.calls[0]?.[0]).toMatchObject({
    context: {
      conversation: [
        { messageId: first, text: 'ada pesanan baru toko berkah' },
        { messageId: second, text: 'sudah ada 12 biji' },
      ],
    },
  });
  expect(await created()).toBe(before + 1);
});

test('SRS §7.3 (FR-RES-01): context is never evidence, and G1, G2 and G4 still reject with it', async () => {
  const when = new Date('2026-10-14T06:00:00Z');
  const earlier = await insertMessage(
    'ada pesanan baru toko berkah',
    new Date(when.getTime() - 60000),
  );
  const own = await insertMessage('uda di konfirm', when);
  const cases: [string, Record<string, unknown>][] = [
    ['G1', { intent: 'status_query' }],
    ['G2', { tense: 'rencana' }],
    ['G4', { completionCondition: null }],
    ['model_invalid_json', { evidenceMessageIds: [earlier] }],
  ];

  for (const [reason, override] of cases) {
    const unitId = await insertUnit([own], when);

    generate.mockImplementation(async (request) => answer(request, override));

    await comprehendGenesisUnit(services, { workspaceId, unitId });

    expect(await reasons(unitId)).toEqual([{ reason }]);
    expect(generate.mock.calls.at(-1)?.[0]).toMatchObject({
      context: { conversation: [expect.any(Object)] },
    });
  }
});

test('SRS §7.3 (FR-RES-01): with no earlier message the context is empty, and G3 rejects fewer than two of who, what and action', async () => {
  const when = new Date('2026-10-15T06:00:00Z');
  const own = await insertMessage('ok', when);
  const unitId = await insertUnit([own], when);

  generate.mockImplementation(async (request) => answer(request, { who: null, what: null }));

  await comprehendGenesisUnit(services, { workspaceId, unitId });

  expect(generate.mock.calls[0]?.[0]).toMatchObject({ context: { conversation: [] } });
  expect(await reasons(unitId)).toEqual([{ reason: 'G3' }]);
});
