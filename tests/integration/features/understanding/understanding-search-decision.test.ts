import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { scopedTransaction } from '../../../../src/platform/db/scoped-transaction.js';
import { comprehendGreyUnit } from '../../../../src/features/understanding/understanding-grey.service.js';
import { runComprehension } from '../../../../src/features/understanding/understanding.jobs.js';
import { recordResolution } from '../../../../src/features/understanding/understanding-resolution.repository.js';

// FR-RES-06 decisions: a search adds the earlier messages as context and their work as candidates; it runs once per unit.
const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000801';
const resolve = createConnectionResolver(pool);
const near = Array.from({ length: 768 }, (_item, index) => (index === 0 ? 1 : 0));
const generate = vi.fn<(request: Record<string, unknown>) => Promise<string>>();
const embed = vi.fn(async (_input: unknown) => near);
const alert = vi.fn();
const publishQuestion = vi.fn(async () => undefined);
const services = {
  resolveConnection: resolve,
  model: { generate },
  now: () => new Date('2026-10-15T09:00:00+07:00'),
  alert,
  publishQuestion,
  embedding: { embed },
  embeddingModel: 'embedding-model',
};
const wib = (local: string) => new Date(Date.parse(`${local}+07:00`)).toISOString();
const reply = (value: unknown) => JSON.stringify(value);
const search = (query: string) => ({ query, from: null, to: null });
let sequence = 0;

async function message(bodySafe: string, when: string) {
  sequence += 1;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages_raw (workspace_id, channel_id, provider_msg_id, sender_external_id, body, body_safe, server_ts, received_ts, origin)
     VALUES ($1, $1, $2, 'customer', 'private', $3, $4, $4, 'user') RETURNING id`,
    [workspaceId, `decision-${sequence}`, bodySafe, when],
  );

  return rows[0].id;
}

async function unit(when: string, messageIds: string[]) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO units (workspace_id, channel_id, text, triage_class, ts_first, ts_last)
     VALUES ($1, $1, 'unit', 'EVENT', $2, $2) RETURNING id`,
    [workspaceId, when],
  );

  for (const messageId of messageIds) {
    await pool.query(
      'INSERT INTO unit_messages (workspace_id, unit_id, message_id) VALUES ($1, $2, $3)',
      [workspaceId, rows[0].id, messageId],
    );
  }

  return rows[0].id;
}

async function embedded(unitId: string) {
  await pool.query(
    'INSERT INTO unit_embeddings (workspace_id, unit_id, embedding, model) VALUES ($1, $2, $3::vector, $4)',
    [workspaceId, unitId, JSON.stringify(near), 'embedding-model'],
  );
}

async function thread(displayId: string, status = 'active') {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO threads (workspace_id, display_id, status, domain_id, channel_id, summary, genesis_confidence)
     VALUES ($1, $2, $3, $1, $1, 'summary', '1') RETURNING id`,
    [workspaceId, displayId, status],
  );

  return rows[0].id;
}

async function link(threadId: string, messageId: string, role: string) {
  await pool.query(
    `INSERT INTO message_thread_link (workspace_id, thread_id, message_id, role, confidence) VALUES ($1, $2, $3, $4, '1')`,
    [workspaceId, threadId, messageId, role],
  );
}

// A grey unit: the resolve step has already recorded GREY over `candidateIds`.
async function greyUnit(candidateIds: string[], when: string, ownMessage: string) {
  const id = await unit(when, [ownMessage]);

  await scopedTransaction(resolve, workspaceId, (tx) =>
    recordResolution(
      tx,
      { workspaceId, unitId: id },
      {
        verdict: 'GREY',
        decidedBy: 'score',
        candidates: candidateIds.map((threadId) => ({ threadId, score: 0.6 })),
        chosenThreadId: null,
      },
    ),
  );

  return id;
}

// A unit the score step has marked CREATE: the genesis step decides it.
async function createUnit(when: string, ownMessage: string) {
  const id = await unit(when, [ownMessage]);

  await scopedTransaction(resolve, workspaceId, (tx) =>
    recordResolution(
      tx,
      { workspaceId, unitId: id },
      { verdict: 'CREATE', decidedBy: 'score', candidates: [], chosenThreadId: null },
    ),
  );

  return id;
}

// An earlier unit of the channel that names the order, embedded like the stored vectors are.
async function earlierUnit(bodySafe: string, when: string, workId?: string) {
  const messageId = await message(bodySafe, when);
  const id = await unit(when, [messageId]);

  await embedded(id);

  if (workId) {
    await link(workId, messageId, 'state_change');
  }

  return { id, messageId };
}

const genesisWithEvidence = (evidenceMessageIds: string[]) => ({
  genesis: {
    domainId: workspaceId,
    intent: 'work_request',
    tense: 'sudah_terjadi',
    who: 'Toko Berkah',
    what: 'pesanan',
    action: 'batal',
    completionCondition: 'dibatalkan',
    summary: 'Pesanan Toko Berkah dibatalkan',
    confidence: 0.9,
    evidenceMessageIds,
  },
  operations: [],
});

const count = async (sql: string) => Number((await pool.query(sql, [workspaceId])).rows[0].n);

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
}, 120000);

beforeEach(async () => {
  vi.resetAllMocks();
  embed.mockImplementation(async () => near);
  await pool.query(
    'TRUNCATE units, messages_raw, threads, message_thread_link, unit_embeddings, unit_resolutions, labels, orphans, open_questions CASCADE',
  );
  await pool.query(
    `DELETE FROM thresholds WHERE workspace_id = $1 AND scope = 'workspace' AND key IN ('questions_per_channel_per_day', 'questions_per_thread_per_day')`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO thresholds (workspace_id, scope, key, value) VALUES ($1, 'workspace', 'questions_per_channel_per_day', 100), ($1, 'workspace', 'questions_per_thread_per_day', 100)`,
    [workspaceId],
  );
});

// T9 — AC5: an unsure grey answer with a search adds the search's work as a candidate and asks once more;
// choosing that work settles the unit.
test('RAG (AC5): an unsure grey answer with a search adds the work it found and settles on a choice of it', async () => {
  const work = await thread('ORD-0901');
  const other = await thread('ORD-0902');

  await link(work, await message('ada pesanan Toko Berkah', wib('2026-10-14T10:00:00')), 'genesis');
  const earlier = await earlierUnit(
    'pesanan Toko Berkah dibatalkan',
    wib('2026-10-13T10:00:00'),
    work,
  );
  const current = await greyUnit(
    [other],
    wib('2026-10-15T09:00:00'),
    await message('yang kemarin udah pesanan baru ternyata ga jadi', wib('2026-10-15T09:00:00')),
  );

  generate
    .mockResolvedValueOnce(
      reply({
        choice: 'not_sure',
        threadId: null,
        supportingMessageIds: [],
        search: search('pesanan Toko Berkah'),
      }),
    )
    .mockResolvedValueOnce(
      reply({ choice: 'candidate', threadId: work, supportingMessageIds: [earlier.messageId] }),
    );

  expect(await comprehendGreyUnit(services, { workspaceId, unitId: current })).toEqual({
    threadId: work,
  });
  expect(generate).toHaveBeenCalledTimes(2);

  const second = generate.mock.calls[1]?.[0] as {
    context: { candidates: { id: string }[]; conversation: { messageId: string }[] };
  };

  expect(second.context.candidates.map((candidate) => candidate.id)).toEqual([other, work]);
  expect(second.context.conversation.map((entry) => entry.messageId)).toContain(earlier.messageId);
  expect(embed).toHaveBeenCalledTimes(1);
  expect(
    (
      await pool.query(
        'SELECT decided_by, chosen_thread_id, search_query, search_hits FROM unit_resolutions WHERE unit_id = $1',
        [current],
      )
    ).rows,
  ).toEqual([
    {
      decided_by: 'model_context',
      chosen_thread_id: work,
      search_query: 'pesanan Toko Berkah',
      search_hits: 1,
    },
  ]);
});

// T10 — AC5, AC8: the second search in the same unit is ignored; the group is asked.
test('RAG (AC5, AC8): a second search for the same unit is ignored and the group is asked', async () => {
  const work = await thread('ORD-1001');
  const earlier = await earlierUnit(
    'pesanan Toko Berkah dibatalkan',
    wib('2026-10-13T10:00:00'),
    work,
  );
  const current = await greyUnit(
    [await thread('ORD-1002')],
    wib('2026-10-15T09:00:00'),
    await message('yang kemarin ga jadi', wib('2026-10-15T09:00:00')),
  );

  generate
    .mockResolvedValueOnce(
      reply({
        choice: 'not_sure',
        threadId: null,
        supportingMessageIds: [],
        search: search('pesanan Toko Berkah'),
      }),
    )
    .mockResolvedValueOnce(
      reply({
        choice: 'not_sure',
        threadId: null,
        supportingMessageIds: [],
        search: search('pesanan lain'),
      }),
    );

  expect(await comprehendGreyUnit(services, { workspaceId, unitId: current })).toBe('done');
  expect(generate).toHaveBeenCalledTimes(2);
  expect(embed).toHaveBeenCalledTimes(1);
  expect(earlier.id).toBeTruthy();
  expect(await count('SELECT count(*)::int AS n FROM open_questions WHERE workspace_id = $1')).toBe(
    1,
  );
  expect(
    (
      await pool.query('SELECT decided_by, search_query FROM unit_resolutions WHERE unit_id = $1', [
        current,
      ])
    ).rows,
  ).toEqual([{ decided_by: 'question', search_query: 'pesanan Toko Berkah' }]);
});

// T11 — AC6: a genesis that is null with a search over linked work becomes GREY over that work,
// and the grey step decides with what was found; without linked work the genesis is asked once more.
test('RAG (AC6): a null genesis with linked work becomes GREY over it, and the grey step decides', async () => {
  const work = await thread('ORD-1101');

  const earlier = await earlierUnit(
    'pesanan Toko Berkah dibatalkan',
    wib('2026-10-13T10:00:00'),
    work,
  );
  const current = await createUnit(
    wib('2026-10-15T09:00:00'),
    await message('yang kemarin udah pesanan baru ternyata ga jadi', wib('2026-10-15T09:00:00')),
  );

  generate
    .mockResolvedValueOnce(
      reply({ genesis: null, operations: [], search: search('pesanan Toko Berkah') }),
    )
    .mockResolvedValueOnce(
      reply({ choice: 'candidate', threadId: work, supportingMessageIds: [earlier.messageId] }),
    )
    .mockResolvedValueOnce(reply({ operations: [] }));

  await runComprehension(services, { workspaceId, unitId: current, threadId: null });

  expect(generate.mock.calls.map((call) => call[0].mode)).toEqual([
    'genesis',
    'grey',
    'comprehend',
  ]);
  expect(
    (
      await pool.query(
        'SELECT verdict, decided_by, chosen_thread_id, search_query FROM unit_resolutions WHERE unit_id = $1',
        [current],
      )
    ).rows,
  ).toEqual([
    {
      verdict: 'GREY',
      decided_by: 'model_context',
      chosen_thread_id: work,
      search_query: 'pesanan Toko Berkah',
    },
  ]);
  expect(await count('SELECT count(*)::int AS n FROM threads WHERE workspace_id = $1')).toBe(1);
});

test('RAG (AC6): without linked work the genesis is asked once more with the retrieved messages', async () => {
  const earlier = await earlierUnit('pesanan Toko Berkah dibatalkan', wib('2026-10-13T10:00:00'));
  const current = await createUnit(
    wib('2026-10-15T09:00:00'),
    await message('yang kemarin udah pesanan baru ternyata ga jadi', wib('2026-10-15T09:00:00')),
  );

  generate
    .mockResolvedValueOnce(
      reply({ genesis: null, operations: [], search: search('pesanan Toko Berkah') }),
    )
    .mockResolvedValueOnce(reply({ genesis: null, operations: [] }));

  await runComprehension(services, { workspaceId, unitId: current, threadId: null });

  expect(generate.mock.calls.map((call) => call[0].mode)).toEqual(['genesis', 'genesis']);
  const again = generate.mock.calls[1]?.[0] as {
    context: { conversation: { messageId: string }[] };
  };

  expect(again.context.conversation.map((entry) => entry.messageId)).toContain(earlier.messageId);
  expect(
    await count("SELECT count(*)::int AS n FROM orphans WHERE workspace_id = $1 AND reason = 'G1'"),
  ).toBe(1);
});

// T12 — AC7: a genesis that cites a retrieved message as evidence is refused; the retrieved message is context only.
test('RAG (AC7): a genesis citing a retrieved message as evidence is refused, and no work is created', async () => {
  const earlier = await earlierUnit('pesanan Toko Berkah dibatalkan', wib('2026-10-13T10:00:00'));
  const current = await createUnit(
    wib('2026-10-15T09:00:00'),
    await message('yang kemarin udah pesanan baru ternyata ga jadi', wib('2026-10-15T09:00:00')),
  );

  generate
    .mockResolvedValueOnce(
      reply({ genesis: null, operations: [], search: search('pesanan Toko Berkah') }),
    )
    .mockResolvedValue(reply(genesisWithEvidence([earlier.messageId])));

  await runComprehension(services, { workspaceId, unitId: current, threadId: null });

  expect(generate).toHaveBeenCalledTimes(3);
  expect(await count('SELECT count(*)::int AS n FROM threads WHERE workspace_id = $1')).toBe(0);
  expect(
    await count(
      "SELECT count(*)::int AS n FROM orphans WHERE workspace_id = $1 AND reason = 'model_invalid_json'",
    ),
  ).toBe(1);
  expect(alert).toHaveBeenCalled();
});
