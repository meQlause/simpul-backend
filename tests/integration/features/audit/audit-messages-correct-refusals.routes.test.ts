import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { signInSeedAdmin } from '../../../helpers/admin-session.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import {
  addOrphanUnit,
  seedMessageLog,
  type MessageLogUnits,
} from '../../../fixtures/message-log.js';
import { createApp } from '../../../../src/app.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';

const pool = databaseFixture();
const seed = pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') });
const replies: (string | Error)[] = [];
const model = {
  generate: vi.fn<(request: { mode: string }) => Promise<string>>(async () => {
    const next = replies.shift() ?? '{"operations":[]}';

    if (next instanceof Error) {
      throw next;
    }

    return next;
  }),
};
const publishMatcher = vi.fn<
  (tx: unknown, payload: { workspaceId: string; labelId: string }) => Promise<unknown>
>(async () => undefined);
let app: ReturnType<typeof createApp>;
let cookie: string;
let units: MessageLogUnits;
let orderId: string;
let salesId: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
  const session = await signInSeedAdmin(pool, {
    id: 'correct-admin',
    email: 'correct-admin@example.test',
  });

  cookie = session.cookie;
  app = createApp('api', undefined, undefined, {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
    audit: { model, publishMatcher },
  });
  units = await seedMessageLog(pool, seed.workspaceId);
  await pool.query('ANALYZE'); // the planner needs real row counts for an 8,400-unit workspace
  await pool.query(
    `INSERT INTO threads (id, workspace_id, display_id, status, domain_id, channel_id, summary, items,
       genesis_confidence, historical, last_activity_at)
     VALUES (gen_random_uuid(), $1, 'ORD-9100', 'active',
       (SELECT id FROM vocab_domains WHERE workspace_id = $1 AND name = 'Order'),
       (SELECT id FROM channels WHERE workspace_id = $1 AND display_name = 'Sales & Order'),
       'Open order', '[]', 1, false, now())`,
    [seed.workspaceId],
  );
  orderId = (
    await pool.query("SELECT id FROM vocab_domains WHERE workspace_id = $1 AND name = 'Order'", [
      seed.workspaceId,
    ])
  ).rows[0].id;
  salesId = (
    await pool.query(
      "SELECT id FROM channels WHERE workspace_id = $1 AND display_name = 'Sales & Order'",
      [seed.workspaceId],
    )
  ).rows[0].id;
}, 120000);

beforeEach(() => {
  model.generate.mockClear();
  publishMatcher.mockClear();
  replies.length = 0;
});

const correct = (unitId: string, body: object) =>
  request(app).post(`/api/v1/messages/${unitId}/correct`).set('Cookie', cookie).send(body);

const count = async (sql: string, params: unknown[] = []) =>
  (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) rows`, params)).rows[0]
    .n;

test('T22: an unknown id, a closed work, and the work the unit is already on are refused; no model call', async () => {
  for (const [displayId, status, closureKind] of [
    ['ORD-9001', 'completed', 'completed'],
    ['ORD-9002', 'cancelled', 'cancelled'],
    ['ORD-9003', 'archived', 'completed'],
  ]) {
    await pool.query(
      `INSERT INTO threads (id, workspace_id, display_id, status, domain_id, channel_id, summary, items,
         genesis_confidence, historical, last_activity_at, closure_kind, closure_reason, closed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'Closed', '[]', 1, false, now(),
         $6, 'Closed for the test', now())`,
      [seed.workspaceId, displayId, status, orderId, salesId, closureKind],
    );
  }

  expect(
    (await correct(units.rejectedG3, { action: 'attach', workDisplayId: 'ORD-9999' })).status,
  ).toBe(404);

  for (const displayId of ['ORD-9001', 'ORD-9002', 'ORD-9003']) {
    const refused = await correct(units.rejectedG3, { action: 'attach', workDisplayId: displayId });

    expect(refused.status).toBe(422);
    expect(refused.body.error.details).toEqual([
      { field: 'workDisplayId', issue: 'invalid', message: 'Choose work that is still open.' },
    ]);
  }

  const same = await correct(units.routed, { action: 'attach', workDisplayId: 'ORD-0091' });

  expect(same.status).toBe(422);
  expect(same.body.error.details).toEqual([{ field: 'workDisplayId', issue: 'invalid' }]);
  expect(model.generate).not.toHaveBeenCalled();
});

test('T24: a model failure during attach answers 500 and changes no label, correction, decision or answered question', async () => {
  const unit = await addOrphanUnit(pool, seed.workspaceId, 'G3', 'Model down');
  const tally = async () => ({
    labels: await count('SELECT id FROM labels'),
    corrections: await count('SELECT id FROM unit_corrections'),
    decisions: await count('SELECT id FROM decisions'),
    answered: await count('SELECT id FROM open_questions WHERE answer IS NOT NULL'),
  });
  const before = await tally();

  replies.push(new Error('model down'));
  const response = await correct(unit.unitId, { action: 'attach', workDisplayId: 'ORD-0098' });

  expect(response.status).toBe(500);
  expect(response.body.error.code).toBe('E-INTERNAL');
  expect(await tally()).toEqual(before);
});

test('T25: two identical attaches at the same moment end as one 200 and one 422, with one correction row', async () => {
  const unit = await addOrphanUnit(pool, seed.workspaceId, 'G3', 'Racing attaches');
  const [first, second] = await Promise.all([
    correct(unit.unitId, { action: 'attach', workDisplayId: 'ORD-9100' }),
    correct(unit.unitId, { action: 'attach', workDisplayId: 'ORD-9100' }),
  ]);

  expect([first.status, second.status].sort()).toEqual([200, 422]);
  expect(await count('SELECT id FROM unit_corrections WHERE unit_id = $1', [unit.unitId])).toBe(1);
});

test('T26: a malformed id, an unknown id, an extra field and a missing field are refused on the field', async () => {
  const body = { action: 'attach', workDisplayId: 'ORD-0098' };

  expect((await correct('not-a-uuid', body)).status).toBe(422);
  expect((await correct(randomUUID(), body)).status).toBe(404);
  expect((await correct(units.rejectedG3, { ...body, extra: 1 })).body.error.details).toEqual([
    { field: 'extra', issue: 'unknown' },
  ]);
  expect((await correct(units.rejectedG3, { action: 'attach' })).body.error.details).toEqual([
    expect.objectContaining({ field: 'workDisplayId' }),
  ]);
  expect(
    (await correct(units.rejectedG3, { action: 'create', summary: 'Missing category' })).body.error
      .details,
  ).toEqual([expect.objectContaining({ field: 'categoryId' })]);
});
