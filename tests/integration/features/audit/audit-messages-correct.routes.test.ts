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
import { routeLabel } from '../../../../src/features/delivery/delivery-routing.service.js';
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

const progressOn = (messageId: string) =>
  JSON.stringify({
    operations: [
      {
        type: 'progress',
        tense: 'sudah_terjadi',
        evidenceMessageIds: [messageId],
        confidence: 0.9,
      },
    ],
  });

// The rows a created work item leaves behind: the thread, its genesis links, the closed orphan, the
// admin resolution, the correction and the decision.
async function expectCreatedWork(unitId: string, work: string) {
  expect(work).toMatch(/^ORD-/);
  expect(
    (
      await pool.query('SELECT status, summary, domain_id FROM threads WHERE display_id = $1', [
        work,
      ])
    ).rows[0],
  ).toEqual({
    status: 'active',
    summary: 'New order from Toko Berkah, 12 pcs',
    domain_id: orderId,
  });
  expect(
    await count(
      `SELECT mtl.message_id FROM message_thread_link mtl JOIN threads t ON t.id = mtl.thread_id
       WHERE mtl.role = 'genesis' AND t.display_id = $1
       AND mtl.message_id IN (SELECT message_id FROM unit_messages WHERE unit_id = $2)`,
      [work, unitId],
    ),
  ).toBe(1);
  expect(
    (await pool.query('SELECT closed_at FROM orphans WHERE unit_id = $1', [unitId])).rows[0]
      .closed_at,
  ).not.toBeNull();
  expect(
    (await pool.query('SELECT decided_by FROM unit_resolutions WHERE unit_id = $1', [unitId]))
      .rows[0].decided_by,
  ).toBe('admin');
  expect(
    (
      await pool.query('SELECT action, previous_outcome FROM unit_corrections WHERE unit_id = $1', [
        unitId,
      ])
    ).rows,
  ).toEqual([{ action: 'create', previous_outcome: 'rejected' }]);
  expect(
    await count("SELECT id FROM decisions WHERE kind = 'work' AND title = $1", [
      `${work} · corrected`,
    ]),
  ).toBe(1);
}

test('T16: create with a summary on a G3 unit returns the new work and writes the thread, links, closed orphan, admin resolution, correction and decision; no model call', async () => {
  const response = await correct(units.rejected, {
    action: 'create',
    categoryId: orderId,
    summary: 'New order from Toko Berkah, 12 pcs',
  });

  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    outcome: 'created',
    correction: { action: 'create', correctedBy: { name: 'Siti Aminah' } },
    steps: expect.arrayContaining([
      expect.objectContaining({ key: 'matched', decidedBy: 'admin' }),
    ]),
  });
  expect(model.generate).not.toHaveBeenCalled();
  await expectCreatedWork(units.rejected, response.body.data.work.displayId);
});

// The genesis the model returns for a message: a work request with the summary, or none.
function genesisReply(messageId: string, summary: string | null) {
  return JSON.stringify({
    genesis:
      summary === null
        ? null
        : {
            domainId: orderId,
            intent: 'work_request',
            tense: 'sudah_terjadi',
            who: 'Toko Berkah',
            what: '12 pcs',
            action: 'order',
            completionCondition: 'Delivered',
            summary,
            confidence: 0.9,
            evidenceMessageIds: [messageId],
          },
    operations: [],
  });
}

test('T17: create without a summary takes the model summary; no genesis or invalid JSON twice gives 422 and writes nothing', async () => {
  const unit = await addOrphanUnit(pool, seed.workspaceId, 'G3', 'Toko Berkah minta 12 pcs');

  replies.push(genesisReply(unit.messageId, 'New order from Toko Berkah, 12 pcs'));
  const created = await correct(unit.unitId, { action: 'create', categoryId: orderId });

  expect(created.status).toBe(200);
  expect(
    (
      await pool.query('SELECT summary FROM threads WHERE display_id = $1', [
        created.body.data.work.displayId,
      ])
    ).rows[0].summary,
  ).toBe('New order from Toko Berkah, 12 pcs');

  const before = await count('SELECT id FROM threads');
  const corrections = await count('SELECT id FROM unit_corrections');

  replies.push(genesisReply(unit.messageId, null), genesisReply(unit.messageId, null));
  const refused = await correct(units.rejectedG3, { action: 'create', categoryId: orderId });

  expect(refused.status).toBe(422);
  expect(refused.body.error).toMatchObject({
    code: 'E-VALIDATION',
    details: [{ field: 'summary', message: 'Enter a short summary.' }],
  });

  replies.push('not json', 'still not json');
  expect((await correct(units.rejectedG3, { action: 'create', categoryId: orderId })).status).toBe(
    422,
  );
  expect(await count('SELECT id FROM threads')).toBe(before);
  expect(await count('SELECT id FROM unit_corrections')).toBe(corrections);
});

test('T18: a long or blank summary, an inactive or foreign category, and a unit that already started work are refused and write nothing', async () => {
  const before = await count('SELECT id FROM threads');

  expect(
    (
      await correct(units.rejectedG3, {
        action: 'create',
        categoryId: orderId,
        summary: 'x'.repeat(201),
      })
    ).body.error.details,
  ).toEqual([{ field: 'summary', issue: 'invalid' }]);
  expect(
    (await correct(units.rejectedG3, { action: 'create', categoryId: orderId, summary: '   ' }))
      .body.error.details,
  ).toEqual([{ field: 'summary', issue: 'invalid' }]);

  await pool.query("UPDATE vocab_domains SET active = false WHERE name = 'Finance'");
  const inactive = await correct(units.rejectedG3, {
    action: 'create',
    categoryId: (
      await pool.query(
        "SELECT id FROM vocab_domains WHERE name = 'Finance' AND workspace_id = $1",
        [seed.workspaceId],
      )
    ).rows[0].id,
    summary: 'Payment',
  });

  await pool.query("UPDATE vocab_domains SET active = true WHERE name = 'Finance'");

  expect(inactive.body.error.details).toEqual([{ field: 'categoryId', issue: 'invalid' }]);
  expect(
    (
      await correct(units.rejectedG3, {
        action: 'create',
        categoryId: randomUUID(),
        summary: 'Foreign',
      })
    ).body.error.details,
  ).toEqual([{ field: 'categoryId', issue: 'invalid' }]);

  const started = await correct(units.created, {
    action: 'create',
    categoryId: orderId,
    summary: 'Again',
  });

  expect(started.status).toBe(422);
  expect(started.body.error.details).toEqual([
    { field: 'action', issue: 'invalid', message: 'This message already started this work.' },
  ]);
  expect(await count('SELECT id FROM threads')).toBe(before);
});

test('T19: a created work item has one label with the unit evidence, and the matcher is published once with that label', async () => {
  const unit = await addOrphanUnit(pool, seed.workspaceId, 'G3', 'New order, 6 pcs');
  const response = await correct(unit.unitId, {
    action: 'create',
    categoryId: orderId,
    summary: 'New order, 6 pcs',
  });

  expect(response.status).toBe(200);

  const labels = (
    await pool.query<{ id: string; evidence_message_ids: string[] }>(
      `SELECT l.id, l.evidence_message_ids FROM labels l JOIN threads t ON t.id = l.thread_id
       WHERE l.unit_id = $1 AND t.display_id = $2`,
      [unit.unitId, response.body.data.work.displayId],
    )
  ).rows;

  expect(labels).toHaveLength(1);
  expect(labels[0].evidence_message_ids).toEqual([unit.messageId]);
  expect(publishMatcher).toHaveBeenCalledTimes(1);
  expect(publishMatcher.mock.calls[0][1]).toMatchObject({ labelId: labels[0].id });

  // The gate routes the label: the active 'new' rule for Order notifies its recipient once.
  await routeLabel(
    {
      resolveConnection: createConnectionResolver(pool),
      now: () => new Date('2026-10-14T03:00:00Z'),
    },
    { workspaceId: seed.workspaceId, labelId: labels[0].id },
  );
  expect(await count('SELECT id FROM notifications WHERE label_id = $1', [labels[0].id])).toBe(1);
});

test('T20: attach on a held unit answers the question, writes the model label on ORD-0098 and publishes it', async () => {
  const messageId = (
    await pool.query<{ message_id: string }>(
      'SELECT message_id FROM unit_messages WHERE unit_id = $1',
      [units.held],
    )
  ).rows[0].message_id;

  replies.push(progressOn(messageId));
  const response = await correct(units.held, { action: 'attach', workDisplayId: 'ORD-0098' });

  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    outcome: 'attached',
    work: { displayId: 'ORD-0098' },
  });
  expect(model.generate).toHaveBeenCalledTimes(1);
  expect(model.generate.mock.calls[0][0]).toMatchObject({ mode: 'comprehend' });
  expect(
    (
      await pool.query('SELECT answer, answered_by FROM open_questions WHERE unit_id = $1', [
        units.held,
      ])
    ).rows[0].answer,
  ).toBe('admin');
  expect(
    await count(
      `SELECT l.id FROM labels l JOIN threads t ON t.id = l.thread_id
       WHERE l.unit_id = $1 AND t.display_id = 'ORD-0098'`,
      [units.held],
    ),
  ).toBe(1);
  expect(publishMatcher).toHaveBeenCalledTimes(1);
  expect(
    (
      await pool.query(
        "SELECT previous_outcome FROM unit_corrections WHERE unit_id = $1 AND action = 'attach'",
        [units.held],
      )
    ).rows,
  ).toEqual([{ previous_outcome: 'held' }]);
});

test('T21: attach to another work moves the unit: the old label, its unsent notification and its marker are retracted', async () => {
  const label = (
    await pool.query<{ id: string; op_id: string; thread_id: string }>(
      `SELECT id, op_id, thread_id FROM labels WHERE unit_id = $1 AND retracted_at IS NULL`,
      [units.attached],
    )
  ).rows[0];

  await pool.query(
    `INSERT INTO notifications (workspace_id, label_id, thread_id, channel, body_rendered, held_until, kind, destination_channel_id, created_at)
     VALUES ($1, $2, $3, 'telegram', 'Pending', '2099-01-01T00:00:00Z', 'update', $4, now())`,
    [seed.workspaceId, label.id, label.thread_id, salesId],
  );
  await pool.query(
    `INSERT INTO progress_markers (workspace_id, thread_id, ts, text, type, op_id)
     VALUES ($1, $2, now(), 'Attached', 'progress', $3)`,
    [seed.workspaceId, label.thread_id, label.op_id],
  );

  const response = await correct(units.attached, { action: 'attach', workDisplayId: 'ORD-9100' });

  expect(response.status).toBe(200);
  expect(response.body.data.work.displayId).toBe('ORD-9100');
  expect(
    (await pool.query('SELECT retracted_at FROM labels WHERE id = $1', [label.id])).rows[0]
      .retracted_at,
  ).not.toBeNull();
  expect(
    await count('SELECT id FROM notifications WHERE label_id = $1 AND cancelled_at IS NOT NULL', [
      label.id,
    ]),
  ).toBe(1);
  expect(
    await count('SELECT id FROM progress_markers WHERE op_id = $1 AND retracted_at IS NOT NULL', [
      label.op_id,
    ]),
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT previous_outcome FROM unit_corrections WHERE unit_id = $1 AND action = 'attach'",
        [units.attached],
      )
    ).rows,
  ).toEqual([{ previous_outcome: 'attached' }]);
});

test('T23: two attaches in a row leave two correction rows, the newest in force, and the first target labels retracted', async () => {
  const unit = await addOrphanUnit(pool, seed.workspaceId, 'G3', 'Moved twice');

  replies.push(progressOn(unit.messageId));
  expect((await correct(unit.unitId, { action: 'attach', workDisplayId: 'ORD-0098' })).status).toBe(
    200,
  );

  const second = await correct(unit.unitId, { action: 'attach', workDisplayId: 'ORD-9100' });

  expect(second.status).toBe(200);
  expect(second.body.data).toMatchObject({
    work: { displayId: 'ORD-9100' },
    correction: { workDisplayId: 'ORD-9100' },
  });
  expect(await count('SELECT id FROM unit_corrections WHERE unit_id = $1', [unit.unitId])).toBe(2);
  expect(
    await count(
      `SELECT l.id FROM labels l JOIN threads t ON t.id = l.thread_id
       WHERE l.unit_id = $1 AND t.display_id = 'ORD-0098' AND l.retracted_at IS NULL`,
      [unit.unitId],
    ),
  ).toBe(0);
});

test('T51: attach where the model returns no operation answers 200 and writes the correction only', async () => {
  const unit = await addOrphanUnit(pool, seed.workspaceId, 'G3', 'Only the attach');
  const response = await correct(unit.unitId, { action: 'attach', workDisplayId: 'ORD-0098' });

  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    outcome: 'attached',
    work: { displayId: 'ORD-0098' },
  });
  expect(await count('SELECT id FROM labels WHERE unit_id = $1', [unit.unitId])).toBe(0);
  expect(await count('SELECT id FROM unit_corrections WHERE unit_id = $1', [unit.unitId])).toBe(1);
  expect(publishMatcher).not.toHaveBeenCalled();
});
