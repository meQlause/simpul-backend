import { beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { seedMessageLog, type MessageLogUnits } from '../../../fixtures/message-log.js';
import { signInSeedAdmin } from '../../../helpers/admin-session.js';
import { createApp } from '../../../../src/app.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';

const pool = databaseFixture();
const seed = pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') });
let app: ReturnType<typeof createApp>;
let cookie: string;
let units: MessageLogUnits;
let baseline: Record<string, number>;

const get = (path: string) => request(app).get(`/api/v1/messages${path}`).set('Cookie', cookie);
const outcomeCounts = async () => (await get('?limit=1')).body.counts as Record<string, number>;
// The seeded units are the newest in the workspace, so the first page of 100 holds every row read
// here. Paging is covered by AC10; following every page of ~8,400 point-star units is too slow.
const newestRows = async (query = '') => {
  const params = ['limit=100', query].filter(Boolean).join('&');
  const response = await get(`?${params}`);

  return response.body.data as {
    unitId: string;
    outcome: string;
    channel: { id: string };
    text: string | null;
    work: { displayId: string } | null;
    steps: { key: string }[];
  }[];
};

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
  const session = await signInSeedAdmin(pool, {
    id: 'message-admin',
    email: 'message-admin@example.test',
  });

  cookie = session.cookie;
  app = createApp('api', undefined, undefined, {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
  });
  baseline = await outcomeCounts();
  units = await seedMessageLog(pool, seed.workspaceId);
  await pool.query('ANALYZE'); // the planner needs real row counts for an 8,400-unit workspace
}, 120000);

test('AC1: GET /messages returns each unit once with its outcome, newest first, and counts rise by the outcome of each new unit', async () => {
  const response = await get('?limit=100');

  expect(response.status).toBe(200);
  expect(response.body.data[0].unitId).toBe(units.otherChannel);
  expect(new Set(response.body.data.map((row: { unitId: string }) => row.unitId)).size).toBe(
    response.body.data.length,
  );
  expect(await outcomeCounts()).toEqual({
    created: baseline.created + 1,
    attached: baseline.attached + 2,
    held: baseline.held + 1,
    rejected: baseline.rejected + 2,
    ignored: baseline.ignored + 1,
    pending: baseline.pending + 6,
  });
  expect((await request(app).get('/api/v1/messages')).status).toBe(401);
});

test('AC2: each outcome carries its reason in the outcome step, and a question that expired is pending', async () => {
  const rows = await newestRows();
  const outcomeStep = (unitId: string) =>
    rows.find((row) => row.unitId === unitId)?.steps.find((step) => step.key === 'outcome');

  expect(outcomeStep(units.rejectedG3)).toMatchObject({ status: 'failed', reason: 'G3' });
  expect(outcomeStep(units.held)).toMatchObject({ status: 'held', reason: 'question' });
  expect(outcomeStep(units.ignored)).toMatchObject({ status: 'done', reason: 'NOISE' });
  expect(outcomeStep(units.queryG1)).toMatchObject({ status: 'pending', reason: 'query' });
  expect(outcomeStep(units.expiredQuestion)).toMatchObject({
    status: 'pending',
    reason: 'question_expired',
  });
  expect(
    rows.find((row) => row.unitId === units.rejectedG3)?.steps.map((step) => step.key),
  ).toEqual(['read', 'outcome']);
});

test('AC3: a resolution row shows its verdict, its context count and at most three candidates with two-decimal scores', async () => {
  const rows = await newestRows();
  const matched = rows
    .find((row) => row.unitId === units.candidates)
    ?.steps.find((step) => step.key === 'matched');

  expect(matched).toMatchObject({
    verdict: 'GREY',
    decidedBy: 'model_context',
    contextMessages: 2,
    candidates: [
      { displayId: 'ORD-0091', score: '0.91' },
      { displayId: 'ORD-0098', score: '0.58' },
      { displayId: 'ORD-0095', score: '0.10' },
    ],
  });
});

test('AC4: a unit whose label led to a routing decision has a notified step with that decision id; a unit without one has none', async () => {
  const decision = (await pool.query("SELECT id FROM decisions WHERE title = 'Routed to Budi'"))
    .rows[0];
  const rows = await newestRows();
  const notified = (unitId: string) =>
    rows.find((row) => row.unitId === unitId)?.steps.find((step) => step.key === 'notified');

  expect(notified(units.routed)).toEqual({ key: 'notified', decisionId: decision.id });
  expect(notified(units.created)).toBeUndefined();
});

test('AC5: outcome filters the rows and the total, not the counts, and an unknown outcome is refused', async () => {
  const unfiltered = await get('?limit=100');
  const rejected = await get('?outcome=rejected&limit=100');

  expect(rejected.status).toBe(200);
  expect(rejected.body.data.every((row: { outcome: string }) => row.outcome === 'rejected')).toBe(
    true,
  );
  expect(rejected.body.page.total).toBe(baseline.rejected + 2);
  expect(rejected.body.counts).toEqual(unfiltered.body.counts);
  expect((await get('?outcome=nonsense')).status).toBe(422);
  expect((await get('?outcome=nonsense')).body.error.code).toBe('E-VALIDATION');
});

test('AC6: q matches the work display id, the sender name or the channel name, in any case, and not the message body', async () => {
  const byId = await newestRows('q=ord-0091');
  const bySender = await newestRows('q=BUDI');
  const byChannel = await newestRows('q=sales');
  const bodyOnly = await get('?q=yyyyyyyy');

  expect(byId.some((row) => row.unitId === units.attached)).toBe(true);
  expect(byId.every((row) => row.work?.displayId === 'ORD-0091')).toBe(true);
  expect(bySender.length).toBeGreaterThan(0);
  expect(byChannel.some((row) => row.unitId === units.created)).toBe(true);
  expect(bodyOnly.body.data).toEqual([]);
});

test('AC7: with access off, every text is null, textAccess is false, the body is not in the response and nothing is logged', async () => {
  const response = await get('?limit=100');

  expect(response.body.textAccess).toBe(false);
  expect(response.body.data.every((row: { text: string | null }) => row.text === null)).toBe(true);
  expect(JSON.stringify(response.body)).not.toContain('yyyyyyyyyy');
  expect(JSON.stringify(response.body)).not.toContain('xxxxxxxxxx');
  expect((await pool.query('SELECT count(*)::int AS n FROM message_access_log')).rows[0].n).toBe(0);
});

test('AC8: with access on, text is the first 500 characters of body_safe, and the raw body is never returned', async () => {
  await pool.query('UPDATE policies SET message_text_access = true');
  const response = await get('?limit=100');
  const long = response.body.data.find((row: { unitId: string }) => row.unitId === units.longText);

  expect(response.body.textAccess).toBe(true);
  expect(long.text).toBe('y'.repeat(500));
  expect(JSON.stringify(response.body)).not.toContain('xxxxxxxxxx');
  expect((await get('?q=yyyyyyyy')).body.data).toEqual([]);
});

test('AC9: with access on, a page writes one access row per distinct channel, every time it is read, and an empty page writes none', async () => {
  const started = Date.now();
  const before = (await pool.query('SELECT count(*)::int AS n FROM message_access_log')).rows[0].n;
  const first = await get('?limit=100');
  const channels = new Set(
    first.body.data.map((row: { channel: { id: string } }) => row.channel.id),
  ).size;

  expect(channels).toBeGreaterThanOrEqual(2);
  expect((await pool.query('SELECT count(*)::int AS n FROM message_access_log')).rows[0].n).toBe(
    before + channels,
  );
  await get('?limit=100');
  expect((await pool.query('SELECT count(*)::int AS n FROM message_access_log')).rows[0].n).toBe(
    before + 2 * channels,
  );
  await get('?q=no-such-unit-here');
  expect((await pool.query('SELECT count(*)::int AS n FROM message_access_log')).rows[0].n).toBe(
    before + 2 * channels,
  );

  const actor = (await pool.query("SELECT id FROM people WHERE auth_user_id = 'message-admin'"))
    .rows[0].id;
  const logged = (
    await pool.query(
      'SELECT person_id, accessed_at FROM message_access_log ORDER BY accessed_at DESC',
    )
  ).rows;

  expect(logged.every((row) => row.person_id === actor)).toBe(true);
  expect(logged[0].accessed_at.getTime()).toBeGreaterThanOrEqual(started);
});

test('AC10: pages follow the cursor without overlap, a cursor cannot change the filter, and limit above 100 is refused', async () => {
  const first = await get('?limit=2');
  const second = await get(`?limit=2&cursor=${encodeURIComponent(first.body.page.nextCursor)}`);
  const ids = [...first.body.data, ...second.body.data].map(
    (row: { unitId: string }) => row.unitId,
  );

  expect(new Set(ids).size).toBe(4);
  expect(
    (await get(`?outcome=held&cursor=${encodeURIComponent(first.body.page.nextCursor)}`)).status,
  ).toBe(422);
  expect((await get('?limit=101')).status).toBe(422);
});
