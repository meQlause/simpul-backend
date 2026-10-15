import { beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { signInSeedAdmin } from '../../../helpers/admin-session.js';
import { createApp } from '../../../../src/app.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';

// FR-UI-22: the Home series. Seed clock 11:01 WIB; local hours are WIB (+07:00).
const pool = databaseFixture();
const foreignId = '00000000-0000-4000-8000-000000000402';
const now = new Date('2026-10-10T04:01:00Z');
let cookie: string;
let authentication: Awaited<ReturnType<typeof signInSeedAdmin>>['authentication'];
let workspaceId: string;
let seedChannel: string;
let sequence = 0;

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function appAt(clock: Date) {
  return createApp('api', undefined, undefined, {
    authentication,
    resolveConnection: createConnectionResolver(pool),
    overview: { now: () => clock },
  });
}

async function overview(clock: Date, query = '') {
  const response = await request(appAt(clock))
    .get(`/api/v1/overview${query}`)
    .set('Cookie', cookie);

  expect(response.status).toBe(200);

  return response.body.data;
}

async function unit(classification: string | null, when: string) {
  await pool.query(
    `INSERT INTO units (workspace_id, channel_id, text, triage_class, ts_first, ts_last)
     VALUES ($1, $2, 'Series', $3, $4, $4)`,
    [workspaceId, seedChannel, classification, when],
  );
}

// Work that received one message at `when`; a message linked to `threadId` joins that work instead.
async function workAt(workspace: string, channelId: string, when: string, threadId?: string) {
  sequence += 1;
  const message = await pool.query<{ id: string }>(
    `INSERT INTO messages_raw (workspace_id, channel_id, provider_msg_id, sender_external_id, body, body_safe, server_ts, received_ts, origin)
     VALUES ($1, $2, $3, 'series', 'private', 'series text', $4, $4, 'user') RETURNING id`,
    [workspace, channelId, `series-${sequence}`, when],
  );
  const thread =
    threadId ??
    (
      await pool.query<{ id: string }>(
        `INSERT INTO threads (workspace_id, display_id, status, domain_id, channel_id, summary, genesis_confidence)
         VALUES ($1, $2, 'active', (SELECT id FROM vocab_domains WHERE workspace_id = $1 LIMIT 1), $3, 'summary', '1') RETURNING id`,
        [workspace, `SER-${sequence}`, channelId],
      )
    ).rows[0].id;

  await pool.query(
    `INSERT INTO message_thread_link (workspace_id, thread_id, message_id, role, confidence) VALUES ($1, $2, $3, 'state_change', '1')`,
    [workspace, thread, message.rows[0].id],
  );

  return thread;
}

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => now }));
  await seedTenantRows(pool, foreignId);
  const seed = pointStarSeed({ now: () => now });

  workspaceId = seed.workspaceId;
  seedChannel = (await pool.query<{ id: string }>("SELECT md5('point-star-channel-2')::uuid AS id"))
    .rows[0].id;
  const session = await signInSeedAdmin(pool, {
    id: 'series-admin',
    email: 'series@pointstar.example',
  });

  cookie = session.cookie;
  authentication = session.authentication;
}, 120000);

// T1 — AC1: one bucket per elapsed local hour (today) or local day (week), summing to the count.
test('FR-UI-22 (AC1): messagesUnderstood.series has one bucket per elapsed hour and sums to the count', async () => {
  const today = await overview(now);
  const week = await overview(now, '?period=week');

  expect(today.messagesUnderstood.series).toHaveLength(12);
  expect(sum(today.messagesUnderstood.series)).toBe(today.messagesUnderstood.count);
  expect(week.messagesUnderstood.series).toHaveLength(7);
  expect(sum(week.messagesUnderstood.series)).toBe(week.messagesUnderstood.count);
});

// T2 — AC2: an EVENT unit counts in its hour; a NOISE unit in the same hour does not.
test('FR-UI-22 (AC2): an EVENT unit adds one to its hour, a NOISE unit adds nothing', async () => {
  const before = (await overview(now)).messagesUnderstood.series[9];

  await unit('EVENT', '2026-10-10T02:30:00Z');
  await unit('NOISE', '2026-10-10T02:30:00Z');

  expect((await overview(now)).messagesUnderstood.series[9]).toBe(before + 1);
});

// T3 — AC3: activeWork.series counts distinct work per hour of the message; two messages on one work count once.
test('FR-UI-22 (AC3): activeWork.series counts each work once per hour of its messages', async () => {
  const before = await overview(now);
  const first = await workAt(workspaceId, seedChannel, '2026-10-10T03:15:00Z');

  await workAt(workspaceId, seedChannel, '2026-10-10T03:40:00Z', first);

  const after = await overview(now);

  expect(after.activeWork.series).toHaveLength(9);
  expect(after.activeWork.series[7]).toBe(before.activeWork.series[7] + 1);
  expect((await overview(now, '?period=week')).activeWork.series).toHaveLength(7);
});

// T4 — AC4 edge: at 01:30 WIB the day has two hours; the work series reaches back to the evening before.
test('FR-UI-22 (AC4): at 01:30 WIB the message series has two buckets and work reaches back to 17:00', async () => {
  const early = new Date('2026-10-09T18:30:00Z');
  const before = await overview(early);

  await workAt(workspaceId, seedChannel, '2026-10-09T15:10:00Z');

  const after = await overview(early);

  expect(after.messagesUnderstood.series).toHaveLength(2);
  expect(after.activeWork.series).toHaveLength(9);
  expect(after.activeWork.series[5]).toBe(before.activeWork.series[5] + 1);
});

// T5 — AC3 edge: work of another workspace never reaches this workspace's series.
test('FR-UI-22 (AC3 edge): work of another workspace is not counted', async () => {
  const before = await overview(now);

  expect(before.activeWork.series).toHaveLength(9);
  await workAt(foreignId, foreignId, '2026-10-10T03:20:00Z');

  expect((await overview(now)).activeWork.series).toEqual(before.activeWork.series);
});
