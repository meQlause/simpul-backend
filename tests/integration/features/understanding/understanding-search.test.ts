import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { scopedTransaction } from '../../../../src/platform/db/scoped-transaction.js';
import {
  embedUnit,
  searchContext,
} from '../../../../src/features/understanding/understanding-embed.service.js';
import { searchUnits } from '../../../../src/features/understanding/understanding-search.repository.js';
import { searchRange } from '../../../../src/features/understanding/understanding-search.rules.js';
import { recordResolution } from '../../../../src/features/understanding/understanding-resolution.repository.js';
import { selectCandidates } from '../../../../src/features/work/work-candidates.repository.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000601';
const resolve = createConnectionResolver(pool);
const now = new Date('2026-10-15T09:00:00Z');
const unitAt = Date.parse('2026-10-15T02:00:00Z');
const dimensions = 768;
const same = Array.from({ length: dimensions }, (_item, index) => (index === 0 ? 1 : 0));
const embedding = { embed: vi.fn(async (_input: unknown) => same) };
const services = { resolveConnection: resolve, embedding, embeddingModel: 'embedding-model' };
let sequence = 0;
let otherChannel = '';

// A unit of the channel with one message, triaged as `triageClass`, on `when` (UTC).
async function unitWith(
  triageClass: string | null,
  when = '2026-10-14T08:00:00Z',
  channel = workspaceId,
) {
  sequence += 1;
  const { rows: message } = await pool.query<{ id: string }>(
    `INSERT INTO messages_raw (workspace_id, channel_id, provider_msg_id, sender_external_id, body, body_safe, server_ts, received_ts, origin)
     VALUES ($1, $2, $3, 'customer', 'private', $4, $5, $5, 'user') RETURNING id`,
    [workspaceId, channel, `search-${sequence}`, `pesanan ${sequence}`, when],
  );
  const { rows: unit } = await pool.query<{ id: string }>(
    `INSERT INTO units (workspace_id, channel_id, text, triage_class, ts_first, ts_last)
     VALUES ($1, $2, 'unit', $3, $4, $4) RETURNING id`,
    [workspaceId, channel, triageClass, when],
  );

  await pool.query(
    'INSERT INTO unit_messages (workspace_id, unit_id, message_id) VALUES ($1, $2, $3)',
    [workspaceId, unit[0].id, message[0].id],
  );

  return unit[0].id;
}

// The stored vector of a unit, as the embedding job writes it.
async function embed(unitId: string, values: number[]) {
  await pool.query(
    'INSERT INTO unit_embeddings (workspace_id, unit_id, embedding, model) VALUES ($1, $2, $3::vector, $4)',
    [workspaceId, unitId, JSON.stringify(values), 'embedding-model'],
  );
}

async function thread(displayId: string, status: string) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO threads (workspace_id, display_id, status, domain_id, channel_id, summary, genesis_confidence, closed_at, closure_kind)
     VALUES ($1, $2, $3, $1, $1, 'summary', '1', CASE WHEN $3 = 'completed' THEN now() END, CASE WHEN $3 = 'completed' THEN 'completed' END) RETURNING id`,
    [workspaceId, displayId, status],
  );

  return rows[0].id;
}

async function link(threadId: string, unitId: string) {
  await pool.query(
    `INSERT INTO message_thread_link (workspace_id, thread_id, message_id, role, confidence)
     SELECT $1, $2, um.message_id, 'state_change', '1' FROM unit_messages um WHERE um.unit_id = $3`,
    [workspaceId, threadId, unitId],
  );
}

const search = (
  unitId: string,
  vector: number[],
  from: number | null = null,
  to: number | null = null,
) =>
  scopedTransaction(resolve, workspaceId, (tx) =>
    searchUnits(
      tx,
      { workspaceId, unitId },
      {
        vector,
        from: new Date(from ?? unitAt - 14 * 86_400_000),
        to: new Date(to ?? unitAt),
      },
    ),
  );

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO channels (workspace_id, provider, bot_connection_id, provider_chat_id, display_name)
     VALUES ($1, 'telegram', $1, '-100888', 'Other channel') RETURNING id`,
    [workspaceId],
  );

  otherChannel = rows[0].id;
}, 120000);

beforeEach(async () => {
  await pool.query(
    'TRUNCATE unit_embeddings, message_thread_link, threads, unit_resolutions CASCADE',
  );
  await pool.query('DELETE FROM unit_messages');
  await pool.query('DELETE FROM units');
  await pool.query('DELETE FROM messages_raw WHERE provider_msg_id LIKE $1', ['search-%']);
  embedding.embed.mockClear();
});

// T4 — AC1: one 768-value vector per EVENT or QUERY unit; a NOISE unit gets none; a second run stores nothing new.
test('RAG (AC1): embedUnit stores one embedding for a non-NOISE unit, none for NOISE, and skips a stored one', async () => {
  const event = await unitWith('EVENT');
  const noise = await unitWith('NOISE');

  await embedUnit(services, { workspaceId, unitId: event });
  await embedUnit(services, { workspaceId, unitId: noise });
  await embedUnit(services, { workspaceId, unitId: event });

  const rows = await pool.query(
    'SELECT unit_id, model, vector_dims(embedding) AS dims FROM unit_embeddings',
  );

  expect(rows.rows).toEqual([{ unit_id: event, model: 'embedding-model', dims: 768 }]);
  expect(embedding.embed).toHaveBeenCalledTimes(1);
});

// T5 — AC3: the channel's similar units, most similar first, with their messages and linked active work;
// never the unit itself, a NOISE unit, another channel's unit, or one below 0.6; at most 8.
// The unit under search, one near match, a partial match, a far one, a NOISE one and another channel's one.
async function similarChannel() {
  const current = await unitWith('EVENT', '2026-10-15T01:50:00Z');
  const near = await unitWith('EVENT', '2026-10-14T08:00:00Z');
  const partly = await unitWith('QUERY', '2026-10-13T08:00:00Z');
  const far = await unitWith('EVENT', '2026-10-13T09:00:00Z');
  const noise = await unitWith('NOISE', '2026-10-14T09:00:00Z');
  const elsewhere = await unitWith('EVENT', '2026-10-14T10:00:00Z', otherChannel);
  const vectors: [string, number[]][] = [
    [current, same],
    [near, same],
    [partly, [0.8, 0.6, ...Array.from({ length: dimensions - 2 }, () => 0)]],
    [far, [0, 1, ...Array.from({ length: dimensions - 2 }, () => 0)]],
    [noise, same],
    [elsewhere, same],
  ];

  for (const [unit, values] of vectors) {
    await embed(unit, values);
  }

  return { current, near, partly };
}

test('RAG (AC3): searchUnits returns the similar units of the channel with their messages and active work', async () => {
  const { current, near, partly } = await similarChannel();
  const active = await thread('ORD-0501', 'active');
  const completed = await thread('ORD-0502', 'completed');

  await link(active, near);
  await link(completed, partly);

  const hits = await search(current, same);

  expect(hits.map((hit) => hit.unitId)).toEqual([near, partly]);
  expect(hits[0]).toMatchObject({ threadIds: [active] });
  expect(hits[0].messages).toEqual([
    expect.objectContaining({
      messageId: expect.any(String),
      text: expect.stringContaining('pesanan'),
    }),
  ]);
  expect(hits[1].threadIds).toEqual([]);
});

// T5 (the limit): nine similar units give eight hits.
test('RAG (AC3): searchUnits returns at most eight hits', async () => {
  const current = await unitWith('EVENT', '2026-10-15T01:50:00Z');

  for (let index = 0; index < 9; index += 1) {
    await embed(await unitWith('EVENT', '2026-10-14T11:00:00Z'), same);
  }

  expect(await search(current, same)).toHaveLength(8);
});

// T6 — AC4: a unit twenty days old is outside the default fourteen days and inside a range from thirty days back.
test('RAG (AC4): the default range is fourteen days before the unit; a wider from reaches older units', async () => {
  const older = await unitWith('EVENT', new Date(unitAt - 20 * 86_400_000).toISOString());
  const current = await unitWith('EVENT', '2026-10-15T01:50:00Z');

  await embed(older, same);

  const defaults = searchRange(unitAt, {});
  const wider = searchRange(unitAt, { from: unitAt - 30 * 86_400_000 });
  const inDefault = await search(current, same, defaults.from, defaults.to);
  const inWider = await search(current, same, wider.from, wider.to);

  expect(inDefault.map((hit) => hit.unitId)).not.toContain(older);
  expect(inWider.map((hit) => hit.unitId)).toContain(older);
});

// T7 — AC8: a search records its query and hit count; a unit is never searched twice.
test('RAG (AC8): searchContext records the query and hit count once, and a second search does nothing', async () => {
  const current = await unitWith('QUERY', '2026-10-15T01:50:00Z');
  const earlier = await unitWith('EVENT', '2026-10-14T08:00:00Z');
  const active = await thread('ORD-0701', 'active');

  await embed(earlier, same);
  await link(active, earlier);
  await scopedTransaction(resolve, workspaceId, (tx) =>
    recordResolution(
      tx,
      { workspaceId, unitId: current },
      { verdict: 'GREY', decidedBy: 'score', candidates: [], chosenThreadId: null },
    ),
  );

  const first = await searchContext(
    services,
    { workspaceId, unitId: current },
    { query: 'pesanan Toko Berkah', from: null, to: null },
  );

  expect(first?.threadIds).toEqual([active]);
  expect(first?.conversation).toHaveLength(1);
  expect(
    (
      await pool.query(
        'SELECT search_query, search_hits FROM unit_resolutions WHERE unit_id = $1',
        [current],
      )
    ).rows,
  ).toEqual([{ search_query: 'pesanan Toko Berkah', search_hits: 1 }]);

  expect(
    await searchContext(
      services,
      { workspaceId, unitId: current },
      { query: 'lagi', from: null, to: null },
    ),
  ).toBeNull();
  expect(embedding.embed).toHaveBeenCalledTimes(1);
});

// T8 — AC9: with stored embeddings, a candidate whose units resemble the unit scores SEMANTIC above 0.
test('RAG (AC9): a candidate whose units are similar to the unit scores SEMANTIC above zero', async () => {
  const prior = await unitWith('EVENT', '2026-10-14T08:00:00Z');
  const current = await unitWith('EVENT');
  const { rows: thread } = await pool.query<{ id: string }>(
    `INSERT INTO threads (workspace_id, display_id, status, domain_id, channel_id, summary, genesis_confidence)
     VALUES ($1, 'RAG-801', 'active', $1, $1, 'summary', '1') RETURNING id`,
    [workspaceId],
  );
  const { rows: linked } = await pool.query<{ message_id: string }>(
    'SELECT message_id FROM unit_messages WHERE unit_id = $1',
    [prior],
  );

  await pool.query(
    `INSERT INTO message_thread_link (workspace_id, thread_id, message_id, role, confidence) VALUES ($1, $2, $3, 'genesis', '1')`,
    [workspaceId, thread[0].id, linked[0].message_id],
  );
  await embedUnit(services, { workspaceId, unitId: prior });
  await embedUnit(services, { workspaceId, unitId: current });

  const candidates = await scopedTransaction(resolve, workspaceId, (tx) =>
    selectCandidates(
      tx,
      workspaceId,
      {
        channelId: workspaceId,
        unitId: current,
        senderId: null,
        explicitIds: [],
        replyIds: [],
        graphThreadIds: [],
      },
      now,
    ),
  );

  expect(candidates.find((candidate) => candidate.id === thread[0].id)?.semantic).toBeGreaterThan(
    0,
  );
});
