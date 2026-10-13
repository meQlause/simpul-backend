import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { scopedTransaction } from '../../../../src/platform/db/scoped-transaction.js';
import { comprehendGreyUnit } from '../../../../src/features/understanding/understanding-grey.service.js';
import { runComprehension } from '../../../../src/features/understanding/understanding.jobs.js';
import { resolveCandidates } from '../../../../src/features/understanding/understanding.resolve.js';
import { recordResolution } from '../../../../src/features/understanding/understanding-resolution.repository.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000501';
const minute = 60_000;
const dayStart = Date.parse('2026-10-13T03:30:00Z');
const day = (index: number) => dayStart + index * 24 * 60 * minute;
const iso = (time: number) => new Date(time).toISOString();
const resolve = createConnectionResolver(pool);
const generate = vi.fn<(request: Record<string, unknown>) => Promise<string>>();
const alert = vi.fn();
const publishQuestion = vi.fn(async () => undefined);
const services = {
  resolveConnection: resolve,
  model: { generate },
  now: () => new Date(day(0)),
  alert,
  publishQuestion,
};
let sequence = 0;
let fixtureThread = '';
let secondThread = '';

async function message(bodySafe: string, when: number) {
  sequence += 1;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages_raw (workspace_id, channel_id, provider_msg_id, sender_external_id, body, body_safe, server_ts, received_ts, origin)
     VALUES ($1, $1, $2, 'sender', 'private raw text', $3, $4, $4, 'user') RETURNING id`,
    [workspaceId, `g-${sequence}`, bodySafe, iso(when)],
  );

  return rows[0].id;
}

async function unit(when: number, messageIds: string[]) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO units (workspace_id, channel_id, sender_id, text, ts_first, ts_last)
     VALUES ($1, $1, $1, 'unit', $2, $2) RETURNING id`,
    [workspaceId, iso(when)],
  );

  for (const messageId of messageIds) {
    await pool.query(
      'INSERT INTO unit_messages (workspace_id, unit_id, message_id) VALUES ($1, $2, $3)',
      [workspaceId, rows[0].id, messageId],
    );
  }

  return rows[0].id;
}

async function thread(displayId: string) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO threads (workspace_id, display_id, status, domain_id, channel_id, summary, genesis_confidence)
     VALUES ($1, $2, 'active', $1, $1, 'summary', '1') RETURNING id`,
    [workspaceId, displayId],
  );

  return rows[0].id;
}

// The grey verdict the resolve step writes before the model is asked.
async function greyUnit(candidateIds: string[], when: number, ownMessage: string) {
  const id = await unit(when, [ownMessage]);

  await scopedTransaction(resolve, workspaceId, (tx) =>
    recordResolution(
      tx,
      { workspaceId, unitId: id },
      {
        verdict: 'GREY',
        decidedBy: 'score',
        candidates: candidateIds.map((threadId, index) => ({ threadId, score: 0.6 - index / 100 })),
        chosenThreadId: null,
      },
    ),
  );

  return id;
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

const reply = (value: unknown) => Promise.resolve(JSON.stringify(value));
const count = async (sql: string) => Number((await pool.query(sql, [workspaceId])).rows[0].n);

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
  fixtureThread = workspaceId;
  secondThread = await thread('ORD-0002');
  await pool.query('UPDATE display_id_counters SET last_value = 100 WHERE workspace_id = $1', [
    workspaceId,
  ]);
}, 120000);

beforeEach(async () => {
  vi.resetAllMocks();
  await pool.query('TRUNCATE labels CASCADE');
  await pool.query('DELETE FROM orphans');
  await pool.query('DELETE FROM open_questions');
  await setThreshold('context_window_minutes', null);
  await setThreshold('questions_per_channel_per_day', 100);
  await setThreshold('questions_per_thread_per_day', 100);
});

test('SRS §6.7 (T-33): with window 0 the model gets no conversation; a clear message chooses new work by citing itself', async () => {
  await setThreshold('context_window_minutes', 0);
  const own = await message('ada pesanan baru Toko Berkah lagi', day(1));
  const id = await greyUnit([fixtureThread], day(1), own);

  generate.mockImplementation(() =>
    reply({ choice: 'new_work', threadId: null, supportingMessageIds: [own] }),
  );

  expect(await comprehendGreyUnit(services, { workspaceId, unitId: id })).toBe('create');
  expect(generate.mock.calls[0]?.[0]).toMatchObject({
    mode: 'grey',
    context: { conversation: [] },
  });
  expect(
    (
      await pool.query(
        'SELECT decided_by, context_message_count FROM unit_resolutions WHERE unit_id = $1',
        [id],
      )
    ).rows,
  ).toEqual([{ decided_by: 'model_context', context_message_count: 0 }]);
});

test('SRS §6.7 (T-33, T-34): an unclear message ends in one question, never a guess', async () => {
  const own = await message('yang itu gimana?', day(2));
  const id = await greyUnit([fixtureThread, secondThread], day(2), own);

  generate.mockImplementation(() =>
    reply({ choice: 'not_sure', threadId: null, supportingMessageIds: [] }),
  );

  expect(await comprehendGreyUnit(services, { workspaceId, unitId: id })).toBe('done');
  expect(await count('SELECT count(*)::int AS n FROM open_questions WHERE workspace_id = $1')).toBe(
    1,
  );
  expect(await count('SELECT count(*)::int AS n FROM labels WHERE workspace_id = $1')).toBe(0);
  expect(await count('SELECT count(*)::int AS n FROM threads WHERE workspace_id = $1')).toBe(2);
  expect(
    (await pool.query('SELECT decided_by FROM unit_resolutions WHERE unit_id = $1', [id])).rows,
  ).toEqual([{ decided_by: 'question' }]);
});

test('SRS §6.7: the model picks a candidate citing a context message; the choice records its context size', async () => {
  const earlier = await message('ada pesanan baru toko berkah', day(4) - 2 * minute);

  await message('sudah ada 12 biji', day(4) - minute);
  const own = await message('uda di konfirm', day(4));
  const id = await greyUnit([fixtureThread, secondThread], day(4), own);

  generate.mockImplementation(() =>
    reply({ choice: 'candidate', threadId: secondThread, supportingMessageIds: [earlier] }),
  );

  expect(await comprehendGreyUnit(services, { workspaceId, unitId: id })).toEqual({
    threadId: secondThread,
  });
  const request = generate.mock.calls[0]?.[0] as {
    mode: string;
    tier: string;
    context: { candidates: unknown[]; conversation: unknown[] };
  };

  expect(request).toMatchObject({ mode: 'grey', tier: 'strong' });
  expect(request.context.candidates).toHaveLength(2);
  expect(request.context.conversation).toHaveLength(2);
  expect(
    (
      await pool.query(
        'SELECT decided_by, chosen_thread_id, context_message_count FROM unit_resolutions WHERE unit_id = $1',
        [id],
      )
    ).rows,
  ).toEqual([
    { decided_by: 'model_context', chosen_thread_id: secondThread, context_message_count: 2 },
  ]);
  expect(await count('SELECT count(*)::int AS n FROM open_questions WHERE workspace_id = $1')).toBe(
    0,
  );
});

test('SRS §6.7 (T-34): a choice outside the list, or with no supporting id, is a question', async () => {
  const cases = [
    { choice: 'candidate', threadId: fixtureThread, supportingMessageIds: [] },
    {
      choice: 'candidate',
      threadId: fixtureThread,
      supportingMessageIds: ['00000000-0000-4000-8000-00000000eeee'],
    },
    {
      choice: 'candidate',
      threadId: '00000000-0000-4000-8000-00000000ffff',
      supportingMessageIds: [],
    },
  ];

  for (const [index, answer] of cases.entries()) {
    const own = await message(`case ${index}`, day(5 + index));
    const id = await greyUnit([fixtureThread], day(5 + index), own);

    generate.mockImplementation(() => reply(answer));
    expect(await comprehendGreyUnit(services, { workspaceId, unitId: id })).toBe('done');
  }

  expect(await count('SELECT count(*)::int AS n FROM open_questions WHERE workspace_id = $1')).toBe(
    3,
  );
  expect(await count('SELECT count(*)::int AS n FROM labels WHERE workspace_id = $1')).toBe(0);
  expect(publishQuestion).toHaveBeenCalledTimes(3);
});

test('SRS §6.7 (T-07): not_sure creates one question with its candidates and publishes it once; a second run does nothing', async () => {
  const own = await message('yang mana?', day(9));
  const id = await greyUnit([fixtureThread, secondThread], day(9), own);

  generate.mockImplementation(() =>
    reply({ choice: 'not_sure', threadId: null, supportingMessageIds: [] }),
  );

  await comprehendGreyUnit(services, { workspaceId, unitId: id });
  expect(publishQuestion).toHaveBeenCalledOnce();
  expect(
    (await pool.query('SELECT thread_ids FROM open_questions WHERE unit_id = $1', [id])).rows[0]
      ?.thread_ids,
  ).toEqual([fixtureThread, secondThread]);

  generate.mockClear();
  publishQuestion.mockClear();
  expect(await comprehendGreyUnit(services, { workspaceId, unitId: id })).toBe('done');
  expect(generate).not.toHaveBeenCalled();
  expect(publishQuestion).not.toHaveBeenCalled();
});

test('SRS §8.4: an exhausted channel quota writes an orphan and leaves decided_by at score; invalid JSON twice quarantines', async () => {
  await setThreshold('questions_per_channel_per_day', 0);
  const quota = await greyUnit([fixtureThread], day(10), await message('quota', day(10)));

  generate.mockImplementation(() =>
    reply({ choice: 'not_sure', threadId: null, supportingMessageIds: [] }),
  );

  expect(await comprehendGreyUnit(services, { workspaceId, unitId: quota })).toBe('done');
  expect(publishQuestion).not.toHaveBeenCalled();
  expect((await pool.query('SELECT reason FROM orphans WHERE unit_id = $1', [quota])).rows).toEqual(
    [{ reason: 'question_quota' }],
  );
  expect(
    (await pool.query('SELECT decided_by FROM unit_resolutions WHERE unit_id = $1', [quota])).rows,
  ).toEqual([{ decided_by: 'score' }]);

  await setThreshold('questions_per_channel_per_day', 100);
  generate.mockClear();
  const broken = await greyUnit([fixtureThread], day(11), await message('broken', day(11)));

  generate.mockImplementation(() => Promise.resolve('{invalid'));

  expect(await comprehendGreyUnit(services, { workspaceId, unitId: broken })).toBe('done');
  expect(generate.mock.calls.map(([request]) => request.temperature)).toEqual([0.2, 0]);
  expect(
    (await pool.query('SELECT reason FROM orphans WHERE unit_id = $1', [broken])).rows,
  ).toEqual([{ reason: 'model_invalid_json' }]);
  expect(alert).toHaveBeenCalledOnce();
});

test('SRS §7.1: a rate limit is rethrown for backoff and writes nothing for the unit', async () => {
  const id = await greyUnit([fixtureThread], day(12), await message('limited', day(12)));
  const rateLimit = Object.assign(new Error('rate limited'), { status: 429 });

  generate.mockRejectedValue(rateLimit);

  await expect(comprehendGreyUnit(services, { workspaceId, unitId: id })).rejects.toBe(rateLimit);
  expect(await count('SELECT count(*)::int AS n FROM open_questions WHERE workspace_id = $1')).toBe(
    0,
  );
  expect(await count('SELECT count(*)::int AS n FROM orphans WHERE workspace_id = $1')).toBe(0);
});

test('SRS §6.7 (FR-RES-03): new work with a cited id is decided as new work; the genesis half of T18 is in phase P4', async () => {
  const earlier = await message('ada pesanan baru toko berkah', day(13) - 2 * minute);
  const own = await message('uda di konfirm ya ternyata 12 biji', day(13));
  const id = await greyUnit([fixtureThread], day(13), own);

  generate.mockImplementation(() =>
    reply({ choice: 'new_work', threadId: null, supportingMessageIds: [earlier] }),
  );

  expect(await comprehendGreyUnit(services, { workspaceId, unitId: id })).toBe('create');
  expect(
    (
      await pool.query(
        'SELECT decided_by, chosen_thread_id, context_message_count FROM unit_resolutions WHERE unit_id = $1',
        [id],
      )
    ).rows,
  ).toEqual([{ decided_by: 'model_context', chosen_thread_id: null, context_message_count: 1 }]);
});

test('SRS §8.4: two concurrent runs on one unit make one question and one publish', async () => {
  const own = await message('serentak', day(14));
  const id = await greyUnit([fixtureThread, secondThread], day(14), own);

  generate.mockImplementation(() =>
    reply({ choice: 'not_sure', threadId: null, supportingMessageIds: [] }),
  );

  await Promise.all([
    comprehendGreyUnit(services, { workspaceId, unitId: id }),
    comprehendGreyUnit(services, { workspaceId, unitId: id }),
  ]);

  expect(await count('SELECT count(*)::int AS n FROM open_questions WHERE workspace_id = $1')).toBe(
    1,
  );
  expect(publishQuestion).toHaveBeenCalledOnce();
});

const jobServices = () => ({ ...services, publishComprehend: vi.fn() });

test('SRS §6.7 (FR-RES-02): through the job, a grey choice of ORD-0002 labels that work, and the comprehension request has no conversation', async () => {
  const earlier = await message('ada pesanan baru toko berkah', day(30) - 2 * minute);
  const own = await message('uda di konfirm', day(30));
  const id = await greyUnit([fixtureThread, secondThread], day(30), own);

  generate.mockImplementation(async (request) =>
    request.mode === 'grey'
      ? reply({ choice: 'candidate', threadId: secondThread, supportingMessageIds: [earlier] })
      : reply({
          operations: [
            {
              type: 'progress',
              tense: 'sudah_terjadi',
              confidence: 0.9,
              evidenceMessageIds: [own],
            },
          ],
        }),
  );

  await runComprehension(jobServices(), { workspaceId, unitId: id, threadId: null });

  expect((await pool.query('SELECT thread_id FROM labels WHERE unit_id = $1', [id])).rows).toEqual([
    { thread_id: secondThread },
  ]);
  const comprehend = generate.mock.calls.find(
    ([request]) => request.mode === 'comprehend',
  )?.[0] as {
    context: object;
  };

  expect(comprehend.context).not.toHaveProperty('conversation');
});

// The Toko Berkah threads of this workspace.
async function tokoThreads() {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM threads WHERE workspace_id = $1 AND customer_label = 'Toko Berkah'",
    [workspaceId],
  );

  return rows.map((row) => row.id);
}

// The grey verdict the resolve step writes for a unit.
function greyVerdict(unitId: string, candidates: { threadId: string; score: number }[]) {
  return scopedTransaction(resolve, workspaceId, (tx) =>
    recordResolution(
      tx,
      { workspaceId, unitId },
      { verdict: 'GREY', decidedBy: 'score', candidates, chosenThreadId: null },
    ),
  );
}

// The model for the first message: a new-work choice that cites it, and the genesis that creates the work.
function firstAnswer(first: string) {
  return async (request: Record<string, unknown>) => {
    if (request.mode === 'genesis') {
      const context = request.context as {
        categories: { id: string }[];
        evidenceMessageIds: string[];
      };

      return reply({
        genesis: {
          domainId: context.categories[0]?.id,
          intent: 'work_event',
          tense: 'sudah_terjadi',
          who: 'Toko Berkah',
          what: 'Indomie 12 dus',
          action: 'pesanan dikonfirmasi',
          completionCondition: 'Pesanan dikirim',
          summary: 'New order from Toko Berkah',
          confidence: 0.9,
          evidenceMessageIds: context.evidenceMessageIds,
        },
        operations: [],
      });
    }

    return reply({ choice: 'new_work', threadId: null, supportingMessageIds: [first] });
  };
}

// T-32 with the new work created by the first message: a fragment attaches to it, and no third item appears.
async function tenMinuteFollowUp(day0: number, fragmentScore: number) {
  const before = await tokoThreads();
  const first = await message('ada pesanan baru toko berkah lagi', day0);
  const firstUnit = await unit(day0, [first]);

  await greyVerdict(firstUnit, [{ threadId: fixtureThread, score: 0.5 }]);
  generate.mockImplementation(firstAnswer(first));
  await runComprehension(jobServices(), { workspaceId, unitId: firstUnit, threadId: null });
  const newWork = (await tokoThreads()).filter((id) => !before.includes(id));

  const follow = await message('uda di konfirm ya ternyata 12 biji', day0 + 2 * minute);
  const followUnit = await unit(day0 + 2 * minute, [follow]);

  await resolveCandidates(
    { resolveConnection: resolve, publishComprehend: vi.fn() },
    { workspaceId, unitId: followUnit },
    {
      candidates: [{ id: newWork[0] ?? fixtureThread, score: fragmentScore, quantity: null }],
      quantity: null,
    },
    new Date(day0),
  );
  generate.mockImplementation(async (request) =>
    request.mode === 'grey'
      ? reply({ choice: 'candidate', threadId: newWork[0], supportingMessageIds: [first] })
      : reply({
          operations: [
            {
              type: 'progress',
              tense: 'sudah_terjadi',
              confidence: 0.9,
              evidenceMessageIds: [follow],
            },
          ],
        }),
  );
  await runComprehension(jobServices(), { workspaceId, unitId: followUnit, threadId: null });

  expect(newWork).toHaveLength(1);
  expect(
    (await pool.query('SELECT thread_id FROM labels WHERE unit_id = $1', [followUnit])).rows,
  ).toEqual([{ thread_id: newWork[0] }]);
  expect(await count('SELECT count(*)::int AS n FROM orphans WHERE workspace_id = $1')).toBe(0);
}

test('SRS §6.7 (T-32, FR-RES-02): a fragment that scores in the grey zone attaches to the work the first message created', async () => {
  await tenMinuteFollowUp(day(31), 0.5);
});

test('SRS §6.7 (T-32, D18): a fragment that scores below 0.45 is promoted to grey over that work and attaches to it too', async () => {
  await tenMinuteFollowUp(day(32), 0.2);
});
