import { beforeAll, beforeEach, expect, test } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { scopedTransaction } from '../../../../src/platform/db/scoped-transaction.js';
import {
  conversationContext,
  recentGenesis,
} from '../../../../src/features/understanding/understanding-resolution.repository.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000401';
const foreignId = '00000000-0000-4000-8000-000000000402';
const resolve = createConnectionResolver(pool);
const minute = 60_000;
// Each scenario gets its own day so their windows never overlap.
const dayStart = Date.parse('2026-10-13T03:30:00Z');
const day = (index: number) => dayStart + index * 24 * 60 * minute;
const iso = (time: number) => new Date(time).toISOString();
let otherChannel = '';
let sequence = 0;

async function message(workspace: string, channel: string, bodySafe: string, when: number) {
  sequence += 1;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages_raw (workspace_id, channel_id, provider_msg_id, sender_external_id, body, body_safe, server_ts, received_ts, origin)
     VALUES ($1, $2, $3, 'sender', 'private raw text', $4, $5, $5, 'user') RETURNING id`,
    [workspace, channel, `m-${sequence}`, bodySafe, iso(when)],
  );

  return rows[0].id;
}

async function simpulMessage(channel: string, bodySafe: string, when: number) {
  sequence += 1;
  await pool.query(
    `INSERT INTO messages_raw (workspace_id, channel_id, provider_msg_id, sender_external_id, body, body_safe, server_ts, received_ts, origin)
     VALUES ($1, $2, $3, 'bot', 'private raw text', $4, $5, $5, 'simpul')`,
    [workspaceId, channel, `m-${sequence}`, bodySafe, iso(when)],
  );
}

async function unit(channel: string, when: number, ownMessages: string[] = []) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO units (workspace_id, channel_id, text, ts_first, ts_last) VALUES ($1, $2, 'unit', $3, $3) RETURNING id`,
    [workspaceId, channel, iso(when)],
  );

  for (const messageId of ownMessages) {
    await pool.query(
      'INSERT INTO unit_messages (workspace_id, unit_id, message_id) VALUES ($1, $2, $3)',
      [workspaceId, rows[0].id, messageId],
    );
  }

  return rows[0].id;
}

async function genesisThread({
  displayId,
  status,
  channel,
  when,
  workspace = workspaceId,
}: {
  displayId: string;
  status: string;
  channel: string;
  when: number;
  workspace?: string;
}) {
  const messageId = await message(workspace, channel, 'genesis text', when);
  const closed = status === 'completed';
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO threads (workspace_id, display_id, status, domain_id, channel_id, summary, genesis_confidence, closed_at, closure_kind, expires_at)
     VALUES ($1, $2, $3, $1, $4, 'summary', '1', $5, $6, $7) RETURNING id`,
    [
      workspace,
      displayId,
      status,
      channel,
      closed ? iso(when) : null,
      closed ? 'completed' : null,
      status === 'tentative' ? iso(when + day(1) - dayStart) : null,
    ],
  );

  await pool.query(
    `INSERT INTO message_thread_link (workspace_id, thread_id, message_id, role, confidence) VALUES ($1, $2, $3, 'genesis', '1')`,
    [workspace, rows[0].id, messageId],
  );

  return rows[0].id;
}

async function setThreshold(key: string, value: number | null) {
  await pool.query(
    `DELETE FROM thresholds WHERE workspace_id = $1 AND scope = 'workspace' AND key = $2`,
    [workspaceId, key],
  );

  if (value !== null) {
    await pool.query(
      `INSERT INTO thresholds (workspace_id, scope, key, value) VALUES ($1, 'workspace', $2, $3)`,
      [workspaceId, key, value],
    );
  }
}

const readContext = (unitId: string) =>
  scopedTransaction(resolve, workspaceId, (tx) => conversationContext(tx, { workspaceId, unitId }));
const readGenesis = (unitId: string) =>
  scopedTransaction(resolve, workspaceId, (tx) => recentGenesis(tx, { workspaceId, unitId }));

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
  await seedTenantRows(pool, foreignId);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO channels (workspace_id, provider, bot_connection_id, provider_chat_id, display_name)
     VALUES ($1, 'telegram', $1, '-100777', 'Other channel') RETURNING id`,
    [workspaceId],
  );

  otherChannel = rows[0].id;
}, 120000);

beforeEach(async () => {
  await setThreshold('context_window_minutes', null);
  await setThreshold('context_max_messages', null);
});

test("SRS §6.7 (FR-RES-01): context is the earlier user messages of the same channel, oldest first, never the unit's own", async () => {
  const base = day(0);

  await message(workspaceId, workspaceId, 'too early', base - 31 * minute);
  const early = await message(
    workspaceId,
    workspaceId,
    'ada pesanan baru toko berkah',
    base - 25 * minute,
  );

  await simpulMessage(workspaceId, 'bot reply', base - 10 * minute);
  const late = await message(workspaceId, workspaceId, 'sudah ada 12 biji', base - 2 * minute);

  await message(workspaceId, otherChannel, 'other chat', base - minute);
  const own = await message(workspaceId, workspaceId, 'the unit itself', base - minute);
  const unitId = await unit(workspaceId, base, [own]);

  expect(await readContext(unitId)).toEqual([
    { messageId: early, text: 'ada pesanan baru toko berkah' },
    { messageId: late, text: 'sudah ada 12 biji' },
  ]);
  await setThreshold('context_max_messages', 1);
  expect(await readContext(unitId)).toEqual([{ messageId: late, text: 'sudah ada 12 biji' }]);
});

test('SRS §6.7 (FR-RES-01): the window edge is inclusive; stored settings are clamped; empty text is skipped', async () => {
  const base = day(1);
  const atEdge = await message(workspaceId, workspaceId, 'exactly thirty', base - 30 * minute);

  await message(workspaceId, workspaceId, 'one second too early', base - 30 * minute - 1000);
  await message(workspaceId, workspaceId, '', base - minute);
  const unitId = await unit(workspaceId, base);

  expect(await readContext(unitId)).toEqual([{ messageId: atEdge, text: 'exactly thirty' }]);

  const old = await message(workspaceId, workspaceId, 'two hours ago', base - 120 * minute);

  await setThreshold('context_window_minutes', 999);
  expect((await readContext(unitId)).map((row) => row.messageId)).toContain(old);

  await setThreshold('context_window_minutes', 30);
  await setThreshold('context_max_messages', 0);
  expect(await readContext(unitId)).toHaveLength(1);
});

test('SRS §6.7 (FR-RES-03): recent work is the genesis inside the window; the edge is inclusive', async () => {
  const base = day(2);
  const recent = await genesisThread({
    displayId: 'ORD-0201',
    status: 'active',
    channel: workspaceId,
    when: base - 2 * minute,
  });
  const edge = await genesisThread({
    displayId: 'ORD-0202',
    status: 'active',
    channel: workspaceId,
    when: base - 30 * minute,
  });

  await genesisThread({
    displayId: 'ORD-0203',
    status: 'active',
    channel: workspaceId,
    when: base - 31 * minute,
  });
  const unitId = await unit(workspaceId, base);

  expect(await readGenesis(unitId)).toEqual([recent, edge]);
});

test('SRS §6.7 (FR-RES-03): a window of zero, another channel, or completed work gives no candidates', async () => {
  await setThreshold('context_window_minutes', 0);
  await genesisThread({
    displayId: 'ORD-0301',
    status: 'active',
    channel: workspaceId,
    when: day(3) - 2 * minute,
  });
  expect(await readGenesis(await unit(workspaceId, day(3)))).toEqual([]);

  await setThreshold('context_window_minutes', null);
  await genesisThread({
    displayId: 'ORD-0302',
    status: 'active',
    channel: otherChannel,
    when: day(4) - 2 * minute,
  });
  expect(await readGenesis(await unit(workspaceId, day(4)))).toEqual([]);

  await genesisThread({
    displayId: 'ORD-0303',
    status: 'completed',
    channel: workspaceId,
    when: day(5) - 2 * minute,
  });
  expect(await readGenesis(await unit(workspaceId, day(5)))).toEqual([]);
});

test('SRS §6.7 (FR-RES-03): at most three newest recent work items; another workspace never counts', async () => {
  const base = day(6);
  const newest = await genesisThread({
    displayId: 'ORD-0401',
    status: 'active',
    channel: workspaceId,
    when: base - minute,
  });
  const second = await genesisThread({
    displayId: 'ORD-0402',
    status: 'active',
    channel: workspaceId,
    when: base - 2 * minute,
  });
  const third = await genesisThread({
    displayId: 'ORD-0403',
    status: 'tentative',
    channel: workspaceId,
    when: base - 3 * minute,
  });

  await genesisThread({
    displayId: 'ORD-0404',
    status: 'active',
    channel: workspaceId,
    when: base - 4 * minute,
  });

  expect(await readGenesis(await unit(workspaceId, base))).toEqual([newest, second, third]);

  await genesisThread({
    displayId: 'ORD-0501',
    status: 'active',
    channel: foreignId,
    when: base + day(1) - 2 * minute,
    workspace: foreignId,
  });
  expect(await readGenesis(await unit(workspaceId, base + day(1)))).toEqual([]);
});

// FR-RES-05: a unit that names a past day reads that day, in the workspace's local time (WIB, +07:00).
const wib = (local: string) => Date.parse(`${local}+07:00`);

async function datedUnit(
  channel: string,
  when: number,
  referencedDate: string | null,
  ownMessages: string[] = [],
) {
  const unitId = await unit(channel, when, ownMessages);

  await pool.query('UPDATE units SET referenced_date = $2 WHERE id = $1', [unitId, referencedDate]);

  return unitId;
}

async function linkMessage(threadId: string, messageId: string, role: string) {
  await pool.query(
    `INSERT INTO message_thread_link (workspace_id, thread_id, message_id, role, confidence) VALUES ($1, $2, $3, $4, '1')`,
    [workspaceId, threadId, messageId, role],
  );
}

// T5 — AC3: the referenced day's messages of the channel, oldest first, instead of the 30 minutes before.
test("FR-RES-05 (AC3): a past referenced day gives that day's channel messages, oldest first, not the window", async () => {
  const early = await message(
    workspaceId,
    workspaceId,
    'dari pagi, 12 biji',
    wib('2026-11-02T08:00:00'),
  );
  const late = await message(
    workspaceId,
    workspaceId,
    'sore, jadi batal',
    wib('2026-11-02T20:00:00'),
  );

  await message(workspaceId, workspaceId, 'hari sebelumnya', wib('2026-11-01T23:50:00'));
  await message(workspaceId, workspaceId, 'hari ini sebelum', wib('2026-11-03T08:30:00'));
  await message(workspaceId, otherChannel, 'chat lain', wib('2026-11-02T21:00:00'));
  const own = await message(
    workspaceId,
    workspaceId,
    'the unit itself',
    wib('2026-11-03T08:59:00'),
  );
  const unitId = await datedUnit(workspaceId, wib('2026-11-03T09:00:00'), '2026-11-02', [own]);

  expect(await readContext(unitId)).toEqual([
    { messageId: early, text: 'dari pagi, 12 biji' },
    { messageId: late, text: 'sore, jadi batal' },
  ]);
  await setThreshold('context_max_messages', 1);
  expect(await readContext(unitId)).toEqual([{ messageId: late, text: 'sore, jadi batal' }]);
});

// T6 — AC4: a day that is today, ahead, or absent keeps the 30-minute window.
test('FR-RES-05 (AC4): a referenced day that is today, ahead, or null keeps the window', async () => {
  const inWindow = await message(workspaceId, workspaceId, 'baru saja', wib('2026-11-10T08:45:00'));

  await message(workspaceId, workspaceId, 'hari sebelumnya', wib('2026-11-09T20:00:00'));
  const today = await datedUnit(workspaceId, wib('2026-11-10T09:00:00'), '2026-11-10');
  const ahead = await datedUnit(workspaceId, wib('2026-11-10T09:00:00'), '2026-11-11');
  const none = await datedUnit(workspaceId, wib('2026-11-10T09:00:00'), null);

  for (const unitId of [today, ahead, none]) {
    expect(await readContext(unitId)).toEqual([{ messageId: inWindow, text: 'baru saja' }]);
  }
});

// T7 — AC5: a window of zero switches date context off as well.
test('FR-RES-05 (AC5): a window of zero gives no context and no follow-up work for a past day', async () => {
  await setThreshold('context_window_minutes', 0);
  await message(workspaceId, workspaceId, 'hari itu', wib('2026-11-21T20:00:00'));
  await genesisThread({
    displayId: 'ORD-0701',
    status: 'active',
    channel: workspaceId,
    when: wib('2026-11-21T20:00:00'),
  });
  const unitId = await datedUnit(workspaceId, wib('2026-11-22T09:00:00'), '2026-11-21');

  expect(await readContext(unitId)).toEqual([]);
  expect(await readGenesis(unitId)).toEqual([]);
});

// T8 — AC6: the referenced day's work of this channel, by any link role, newest first, at most three.
test('FR-RES-05 (AC6): a past referenced day offers the channel work that received a message that day', async () => {
  const linked = await genesisThread({
    displayId: 'ORD-0801',
    status: 'active',
    channel: workspaceId,
    when: wib('2026-11-20T09:00:00'),
  });
  const update = await message(workspaceId, workspaceId, 'tambahan', wib('2026-11-24T11:00:00'));

  await linkMessage(linked, update, 'state_change');
  const genesis = await genesisThread({
    displayId: 'ORD-0802',
    status: 'active',
    channel: workspaceId,
    when: wib('2026-11-24T10:00:00'),
  });
  const tentative = await genesisThread({
    displayId: 'ORD-0803',
    status: 'tentative',
    channel: workspaceId,
    when: wib('2026-11-24T08:00:00'),
  });

  await genesisThread({
    displayId: 'ORD-0804',
    status: 'active',
    channel: workspaceId,
    when: wib('2026-11-24T07:00:00'),
  });
  await genesisThread({
    displayId: 'ORD-0805',
    status: 'completed',
    channel: workspaceId,
    when: wib('2026-11-24T12:00:00'),
  });
  await genesisThread({
    displayId: 'ORD-0806',
    status: 'active',
    channel: otherChannel,
    when: wib('2026-11-24T13:00:00'),
  });
  const unitId = await datedUnit(workspaceId, wib('2026-11-25T09:00:00'), '2026-11-24');

  expect(await readGenesis(unitId)).toEqual([linked, genesis, tentative]);
});
