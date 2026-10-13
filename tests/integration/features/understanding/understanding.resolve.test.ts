import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { resolveCandidates } from '../../../../src/features/understanding/understanding.resolve.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000101';
const ids = [
  workspaceId,
  '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000103',
];
const publishComprehend = vi.fn();
const dependencies = { resolveConnection: createConnectionResolver(pool), publishComprehend };
const scope = { workspaceId, unitId: workspaceId };
const candidates = ids.map((id, index) => ({
  id,
  score: [0.6, 0.54, 0.52][index],
  quantity: null,
}));
const now = new Date('2026-10-10T04:01:00Z');

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
  await pool.query(
    "INSERT INTO threads (id, workspace_id, display_id, status, domain_id, channel_id, summary, genesis_confidence) SELECT x.id, $1, x.display_id, 'active', $1, $1, 'Candidate', 0.9 FROM (VALUES ($2::uuid, 'ORD-0002'), ($3::uuid, 'ORD-0003')) x(id, display_id)",
    ids,
  );
}, 120000);

beforeEach(async () => {
  await pool.query('DELETE FROM open_questions');
  await pool.query('DELETE FROM orphans');
  await pool.query('DELETE FROM unit_resolutions');
  publishComprehend.mockClear();
});

let counter = 0;

// A unit of its own, so each case starts with no verdict and no outcome.
async function newUnit(when: Date, triageClass = 'EVENT') {
  counter += 1;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO units (workspace_id, channel_id, sender_id, text, triage_class, ts_first, ts_last)
     VALUES ($1, $1, $1, 'unit ' || $2, $3, $4, $4) RETURNING id`,
    [workspaceId, counter, triageClass, when],
  );

  return { workspaceId, unitId: rows[0].id };
}

const resolution = (unitId: string) =>
  pool
    .query(
      'SELECT verdict, decided_by, candidates, chosen_thread_id FROM unit_resolutions WHERE unit_id = $1',
      [unitId],
    )
    .then((result) => result.rows);
const openQuestions = async () =>
  Number((await pool.query('SELECT count(*)::int AS n FROM open_questions')).rows[0].n);

test('SRS §6.1 (FR-RES-04): a GREY verdict records its candidates and publishes one comprehension job, with no question', async () => {
  await resolveCandidates(dependencies, scope, { candidates, quantity: null }, now);

  expect(await resolution(workspaceId)).toEqual([
    {
      verdict: 'GREY',
      decided_by: 'score',
      candidates: ids.map((threadId, index) => ({ threadId, score: [0.6, 0.54, 0.52][index] })),
      chosen_thread_id: null,
    },
  ]);
  expect(publishComprehend).toHaveBeenCalledOnce();
  expect(await openQuestions()).toBe(0);
});

test('SRS §6.7 (FR-RES-04): the same unit resolved again replaces its row, and at most three candidates are stored', async () => {
  const unit = await newUnit(now);
  const four = [...ids, '00000000-0000-4000-8000-000000000199'].map((id, index) => ({
    id,
    score: 0.6 - index / 100,
    quantity: null,
  }));

  await resolveCandidates(dependencies, unit, { candidates: four, quantity: null }, now);
  await resolveCandidates(dependencies, unit, { candidates, quantity: null }, now);

  const rows = await resolution(unit.unitId);

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ verdict: 'GREY', candidates: expect.any(Array) });
  expect((rows[0] as { candidates: unknown[] }).candidates).toHaveLength(3);
});

test('SRS §6.1 (FR-RES-04): a reference attaches with decided_by reference; a score attaches with decided_by score; CREATE chooses nothing', async () => {
  const reference = await newUnit(now);
  const scored = await newUnit(now);
  const created = await newUnit(now);

  await resolveCandidates(
    dependencies,
    reference,
    { candidates: [{ id: ids[0], score: 0.95, quantity: null, reference: true }], quantity: null },
    now,
  );
  await resolveCandidates(
    dependencies,
    scored,
    {
      candidates: [
        { id: ids[1], score: 0.9, quantity: null },
        { id: ids[2], score: 0.1, quantity: null },
      ],
      quantity: null,
    },
    now,
  );
  await resolveCandidates(
    dependencies,
    created,
    { candidates: [{ id: ids[2], score: 0.2, quantity: null }], quantity: null },
    now,
  );

  expect(await resolution(reference.unitId)).toMatchObject([
    { verdict: 'ATTACH', decided_by: 'reference', chosen_thread_id: ids[0] },
  ]);
  expect(await resolution(scored.unitId)).toMatchObject([
    { verdict: 'ATTACH', decided_by: 'score', chosen_thread_id: ids[1] },
  ]);
  expect(await resolution(created.unitId)).toMatchObject([
    { verdict: 'CREATE', decided_by: 'score', chosen_thread_id: null },
  ]);
});

test('SRS §6.7 (FR-RES-03): a QUERY with a CREATE verdict and no recent work still gets its G1 orphan and its row', async () => {
  const query = await newUnit(now, 'QUERY');

  await resolveCandidates(
    dependencies,
    query,
    { candidates: [{ id: ids[2], score: 0.2, quantity: null }], quantity: null },
    now,
  );

  expect(await resolution(query.unitId)).toMatchObject([
    { verdict: 'CREATE', decided_by: 'score' },
  ]);
  expect(
    (await pool.query('SELECT reason FROM orphans WHERE unit_id = $1', [query.unitId])).rows,
  ).toEqual([{ reason: 'G1' }]);
  expect(publishComprehend).not.toHaveBeenCalled();
});

test('SRS §6.7 (FR-RES-03, D18): a CREATE with recent work two minutes earlier is GREY over that work; without it the unit stays CREATE', async () => {
  const withWork = await newUnit(now);
  const message = await pool.query<{ id: string }>(
    `INSERT INTO messages_raw (workspace_id, channel_id, provider_msg_id, sender_external_id, body_safe, server_ts, received_ts)
     VALUES ($1, $1, 'recent-genesis', 'sender', 'ada pesanan baru', $2, $2) RETURNING id`,
    [workspaceId, new Date(now.getTime() - 2 * 60000)],
  );
  const recent = await pool.query<{ id: string }>(
    `INSERT INTO threads (workspace_id, display_id, status, domain_id, channel_id, summary, genesis_confidence)
     VALUES ($1, 'ORD-0901', 'active', $1, $1, 'Recent', 0.9) RETURNING id`,
    [workspaceId],
  );

  await pool.query(
    `INSERT INTO message_thread_link (workspace_id, thread_id, message_id, role, confidence) VALUES ($1, $2, $3, 'genesis', 1)`,
    [workspaceId, recent.rows[0].id, message.rows[0].id],
  );

  await resolveCandidates(
    dependencies,
    withWork,
    { candidates: [{ id: ids[0], score: 0.2, quantity: null }], quantity: null },
    now,
  );
  expect(await resolution(withWork.unitId)).toMatchObject([
    {
      verdict: 'GREY',
      decided_by: 'score',
      candidates: [{ threadId: recent.rows[0].id, score: 0 }],
    },
  ]);
  expect(publishComprehend).toHaveBeenCalledOnce();
});

test('SRS §6.7 (FR-RES-03, D18): without recent work a CREATE stays CREATE; a QUERY with recent work is GREY and keeps no G1 orphan', async () => {
  const withoutWork = await newUnit(new Date(now.getTime() + 120 * 60000));
  const queryWithWork = await newUnit(now, 'QUERY');

  publishComprehend.mockClear();
  await resolveCandidates(
    dependencies,
    withoutWork,
    { candidates: [{ id: ids[0], score: 0.2, quantity: null }], quantity: null },
    new Date(now.getTime() + 60 * 60000),
  );
  expect(await resolution(withoutWork.unitId)).toMatchObject([{ verdict: 'CREATE' }]);
  expect(publishComprehend).toHaveBeenCalledOnce();

  publishComprehend.mockClear();
  await resolveCandidates(
    dependencies,
    queryWithWork,
    { candidates: [{ id: ids[0], score: 0.2, quantity: null }], quantity: null },
    now,
  );
  expect(await resolution(queryWithWork.unitId)).toMatchObject([{ verdict: 'GREY' }]);
  expect(
    (await pool.query('SELECT reason FROM orphans WHERE unit_id = $1', [queryWithWork.unitId]))
      .rows,
  ).toEqual([]);
});
