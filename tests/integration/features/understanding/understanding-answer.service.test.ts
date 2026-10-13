import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { scopedTransaction } from '../../../../src/platform/db/scoped-transaction.js';
import { answerClarification } from '../../../../src/features/understanding/understanding-answer.service.js';
import { comprehendGreyUnit } from '../../../../src/features/understanding/understanding-grey.service.js';
import { comprehendUnit } from '../../../../src/features/understanding/understanding.comprehension.js';
import { recordResolution } from '../../../../src/features/understanding/understanding-resolution.repository.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000601';
const minute = 60_000;
const dayStart = Date.parse('2026-10-13T03:30:00Z');
const iso = (time: number) => new Date(time).toISOString();
const resolve = createConnectionResolver(pool);
const generate = vi.fn<(request: Record<string, unknown>) => Promise<string>>();
const alert = vi.fn();
const publishQuestion = vi.fn(async () => undefined);
const publishComprehend = vi.fn(async (_tx: unknown, _payload: unknown) => undefined);
let sequence = 0;
let fixtureThread = '';
let secondThread = '';

async function message(bodySafe: string, when: number) {
  sequence += 1;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages_raw (workspace_id, channel_id, provider_msg_id, sender_external_id, body, body_safe, server_ts, received_ts, origin)
     VALUES ($1, $1, $2, 'sender', 'private raw text', $3, $4, $4, 'user') RETURNING id`,
    [workspaceId, `a-${sequence}`, bodySafe, iso(when)],
  );

  return rows[0].id;
}

// A grey unit with its candidates and a question already asked to the group.
async function askedUnit(when: number) {
  const own = await message('yang mana?', when);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO units (workspace_id, channel_id, sender_id, text, ts_first, ts_last)
     VALUES ($1, $1, $1, 'unit', $2, $2) RETURNING id`,
    [workspaceId, iso(when)],
  );
  const unitId = rows[0].id;

  await pool.query(
    'INSERT INTO unit_messages (workspace_id, unit_id, message_id) VALUES ($1, $2, $3)',
    [workspaceId, unitId, own],
  );
  await scopedTransaction(resolve, workspaceId, (tx) =>
    recordResolution(
      tx,
      { workspaceId, unitId },
      {
        verdict: 'GREY',
        decidedBy: 'score',
        candidates: [
          { threadId: fixtureThread, score: 0.6 },
          { threadId: secondThread, score: 0.55 },
        ],
        chosenThreadId: null,
      },
    ),
  );
  generate.mockImplementation(() =>
    Promise.resolve(
      JSON.stringify({ choice: 'not_sure', threadId: null, supportingMessageIds: [] }),
    ),
  );
  await comprehendGreyUnit(
    {
      resolveConnection: resolve,
      model: { generate },
      now: () => new Date(when),
      alert,
      publishQuestion,
    },
    { workspaceId, unitId },
  );
  const question = await pool.query<{ id: string }>(
    'SELECT id FROM open_questions WHERE unit_id = $1',
    [unitId],
  );

  return { unitId, own, questionId: question.rows[0].id };
}

const answer = (questionId: string, value: string, when: number) =>
  scopedTransaction(resolve, workspaceId, (tx) =>
    answerClarification(
      tx,
      { workspaceId, questionId, actorId: workspaceId, answer: value },
      { now: new Date(when), publishComprehend },
    ),
  );

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
  fixtureThread = workspaceId;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO threads (workspace_id, display_id, status, domain_id, channel_id, summary, genesis_confidence)
     VALUES ($1, 'ORD-0002', 'active', $1, $1, 'summary', '1') RETURNING id`,
    [workspaceId],
  );

  secondThread = rows[0].id;
}, 120000);

beforeEach(async () => {
  vi.resetAllMocks();
  await pool.query('TRUNCATE labels CASCADE');
  await pool.query('DELETE FROM orphans');
  await pool.query(`DELETE FROM thresholds WHERE workspace_id = $1 AND scope = 'workspace'`, [
    workspaceId,
  ]);
  await pool.query(
    `INSERT INTO thresholds (workspace_id, scope, key, value) VALUES ($1, 'workspace', 'questions_per_channel_per_day', 100), ($1, 'workspace', 'questions_per_thread_per_day', 100)`,
    [workspaceId],
  );
});

test("SRS §6.7 (FR-RES-02): the chosen candidate, answered in the group, gets the unit's label on that work item", async () => {
  const when = dayStart + 20 * 24 * 60 * minute;
  const { unitId, own, questionId } = await askedUnit(when);

  expect(await answer(questionId, secondThread, when + minute)).toBe(true);
  expect(publishComprehend).toHaveBeenCalledWith(expect.anything(), {
    workspaceId,
    unitId,
    threadId: secondThread,
  });

  const payload = { workspaceId, unitId, threadId: secondThread };

  generate.mockImplementation(() =>
    Promise.resolve(
      JSON.stringify({
        operations: [
          { type: 'progress', tense: 'sudah_terjadi', confidence: 0.9, evidenceMessageIds: [own] },
        ],
      }),
    ),
  );
  await comprehendUnit({ resolveConnection: resolve, model: { generate }, alert }, payload);

  expect(
    (await pool.query('SELECT thread_id FROM labels WHERE unit_id = $1', [unitId])).rows,
  ).toEqual([{ thread_id: secondThread }]);
  expect(
    (
      await pool.query(
        'SELECT chosen_thread_id, decided_by FROM unit_resolutions WHERE unit_id = $1',
        [unitId],
      )
    ).rows,
  ).toEqual([{ chosen_thread_id: secondThread, decided_by: 'question' }]);
});

test('SRS §8.4: "none" closes the question without a label or a publish, and a second answer is refused', async () => {
  const when = dayStart + 21 * 24 * 60 * minute;
  const { unitId, questionId } = await askedUnit(when);

  expect(await answer(questionId, 'none', when + minute)).toBe(true);
  expect(publishComprehend).not.toHaveBeenCalled();
  expect(
    (await pool.query('SELECT count(*)::int AS n FROM labels WHERE unit_id = $1', [unitId])).rows[0]
      ?.n,
  ).toBe(0);
  expect(await answer(questionId, secondThread, when + 2 * minute)).toBe(false);
});

test('SRS §8.4: an answer after the question expired is refused and changes nothing', async () => {
  const when = dayStart + 22 * 24 * 60 * minute;
  const { unitId, questionId } = await askedUnit(when);

  expect(await answer(questionId, secondThread, when + 11 * minute)).toBe(false);
  expect(publishComprehend).not.toHaveBeenCalled();
  expect(
    (await pool.query('SELECT answer FROM open_questions WHERE unit_id = $1', [unitId])).rows,
  ).toEqual([{ answer: null }]);
});
