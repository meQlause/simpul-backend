import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import request from 'supertest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { signInSeedAdmin } from '../../../helpers/admin-session.js';
import { createApp } from '../../../../src/app.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';

const pool = databaseFixture();
const now = new Date('2026-10-10T04:01:00Z');
const publishMatcher = vi.fn(async () => undefined);
let app: ReturnType<typeof createApp>;
let cookie: string;
let pakBud: string;
let budi: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => now }));
  const session = await signInSeedAdmin(pool, {
    id: 'review-admin',
    email: 'review@pointstar.example',
  });

  cookie = session.cookie;
  app = createApp('api', undefined, undefined, {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
    review: { now: () => now, publishMatcher },
  });
  pakBud = (await pool.query("SELECT id FROM review_items WHERE detected_text = 'Pak Bud'")).rows[0]
    .id;
  budi = (await pool.query("SELECT id FROM people WHERE name = 'Budi Santoso'")).rows[0].id;
}, 120000);

beforeEach(async () => {
  await pool.query('UPDATE review_items SET resolved_at = NULL, resolved_by = NULL');
  await pool.query('DELETE FROM aliases');
  await pool.query('DELETE FROM config_audit');
  publishMatcher.mockReset();
  publishMatcher.mockResolvedValue(undefined);
});

test('Review queue §3: category resolution re-categorises the label and queues matching in the transaction', async () => {
  const item = (await pool.query("SELECT id, label_id FROM review_items WHERE kind = 'category'"))
    .rows[0];
  const category = (await pool.query("SELECT id FROM vocab_domains WHERE name = 'Product samples'"))
    .rows[0].id;
  const response = await request(app)
    .post(`/api/v1/review-items/${item.id}/resolve`)
    .set('Cookie', cookie)
    .send({ categoryId: category });

  expect(response.status).toBe(200);
  expect(
    (await pool.query('SELECT domain_id, routed_at FROM labels WHERE id = $1', [item.label_id]))
      .rows,
  ).toEqual([{ domain_id: category, routed_at: null }]);
  expect(publishMatcher).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    workspaceId: pointStarSeed({ now: () => now }).workspaceId,
    labelId: item.label_id,
  });
});

test('Review queue §3: failed matcher publishing rolls back category resolution', async () => {
  const item = (await pool.query("SELECT id, label_id FROM review_items WHERE kind = 'category'"))
    .rows[0];
  const category = (await pool.query("SELECT id FROM vocab_domains WHERE name = 'Returns'")).rows[0]
    .id;
  const before = (
    await pool.query('SELECT domain_id, routed_at FROM labels WHERE id = $1', [item.label_id])
  ).rows;

  publishMatcher.mockRejectedValue(new Error('queue unavailable'));
  const response = await request(app)
    .post(`/api/v1/review-items/${item.id}/resolve`)
    .set('Cookie', cookie)
    .send({ categoryId: category });

  expect(response.status).toBe(500);
  expect(
    (await pool.query('SELECT domain_id, routed_at FROM labels WHERE id = $1', [item.label_id]))
      .rows,
  ).toEqual(before);
  expect(
    (await pool.query('SELECT resolved_at FROM review_items WHERE id = $1', [item.id])).rows,
  ).toEqual([{ resolved_at: null }]);
  expect((await pool.query('SELECT * FROM config_audit')).rowCount).toBe(0);
});

test('Review queue §1: the seed returns 7 with counts 4, 2, 1', async () => {
  const response = await request(app).get('/api/v1/review-items').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data).toHaveLength(7);
  expect(response.body.page).toEqual({ total: 7, nextCursor: null });
  expect(response.body.counts).toEqual({ unrouted: 4, alias: 2, category: 1 });
  expect(response.body.data.find((item: { id: string }) => item.id === pakBud)).toMatchObject({
    detected: { text: 'Pak Bud', suggestedPersonId: null, suggestedCategoryId: null },
  });
});

test('Review queue §3: resolving Pak Bud creates the alias and leaves 6, with atomic audit', async () => {
  const response = await request(app)
    .post(`/api/v1/review-items/${pakBud}/resolve`)
    .set('Cookie', cookie)
    .send({ personId: budi });

  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    id: pakBud,
    resolvedAt: now.toISOString(),
    remaining: { unrouted: 4, alias: 1, category: 1 },
  });
  expect((await pool.query("SELECT person_id FROM aliases WHERE alias = 'Pak Bud'")).rows).toEqual([
    { person_id: budi },
  ]);
  expect(
    (await pool.query('SELECT table_name FROM config_audit ORDER BY table_name')).rows,
  ).toEqual([{ table_name: 'aliases' }, { table_name: 'review_items' }]);
  const list = await request(app).get('/api/v1/review-items').set('Cookie', cookie);

  expect(list.body.page.total).toBe(6);
  expect(
    (await request(app).get(`/api/v1/review-items/${pakBud}`).set('Cookie', cookie)).status,
  ).toBe(404);
});

test('Review queue §1: filter counts ignore kind and search; cursors are tied to their filter', async () => {
  const first = await request(app)
    .get('/api/v1/review-items?kind=alias&limit=1')
    .set('Cookie', cookie);

  expect(first.status).toBe(200);
  expect(first.body.page.total).toBe(2);
  expect(first.body.counts).toEqual({ unrouted: 4, alias: 2, category: 1 });
  const second = await request(app)
    .get('/api/v1/review-items')
    .query({ kind: 'alias', limit: 1, cursor: first.body.page.nextCursor })
    .set('Cookie', cookie);

  expect(second.status).toBe(200);
  expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
  expect(second.body.page.nextCursor).toBeNull();
  const mismatch = await request(app)
    .get('/api/v1/review-items')
    .query({ kind: 'category', cursor: first.body.page.nextCursor })
    .set('Cookie', cookie);

  expect(mismatch.status).toBe(422);
  const search = await request(app).get('/api/v1/review-items?q=warehouse').set('Cookie', cookie);

  expect(search.status).toBe(200);
  expect(search.body.data.length).toBeGreaterThan(0);
  expect(search.body.counts).toEqual(first.body.counts);
});

test('Review queue §3: concurrent resolution succeeds once and reuses an identical alias', async () => {
  await pool.query(
    "INSERT INTO aliases (workspace_id, alias, person_id) SELECT workspace_id, 'Pak Bud', id FROM people WHERE id = $1",
    [budi],
  );
  const responses = await Promise.all(
    [1, 2].map(() =>
      request(app)
        .post(`/api/v1/review-items/${pakBud}/resolve`)
        .set('Cookie', cookie)
        .send({ personId: budi }),
    ),
  );

  expect(responses.map((response) => response.status).sort()).toEqual([200, 404]);
  expect((await pool.query("SELECT * FROM aliases WHERE alias = 'Pak Bud'")).rowCount).toBe(1);
});

test.each([
  { personId: 'not-a-uuid' },
  { personId: '00000000-0000-4000-8000-000000000999' },
  {
    personId: '00000000-0000-4000-8000-000000000999',
    categoryId: '00000000-0000-4000-8000-000000000999',
  },
  { resolvedBy: 'admin' },
])('Review queue §3: invalid resolution %j changes nothing', async (body) => {
  const response = await request(app)
    .post(`/api/v1/review-items/${pakBud}/resolve`)
    .set('Cookie', cookie)
    .send(body);

  expect(response.status).toBe(422);
  expect(
    (await pool.query('SELECT * FROM review_items WHERE resolved_at IS NOT NULL')).rowCount,
  ).toBe(0);
  expect((await pool.query('SELECT * FROM aliases')).rowCount).toBe(0);
});

test.each([
  { kind: 'invalid' },
  { limit: 101 },
  { cursor: 'invalid' },
  { q: 'a'.repeat(101) },
  { workspaceId: 'foreign' },
])('Review queue §1: invalid query %j is rejected', async (query) => {
  const response = await request(app)
    .get('/api/v1/review-items')
    .query(query)
    .set('Cookie', cookie);

  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe('E-VALIDATION');
});

test('Review queue §3: an existing different alias mapping is not overwritten', async () => {
  const rina = (await pool.query("SELECT id FROM people WHERE name = 'Rina Anggraini'")).rows[0].id;

  await pool.query(
    "INSERT INTO aliases (workspace_id, alias, person_id) SELECT workspace_id, 'pak bud', id FROM people WHERE id = $1",
    [rina],
  );
  const response = await request(app)
    .post('/api/v1/review-items/' + pakBud + '/resolve')
    .set('Cookie', cookie)
    .send({ personId: budi });

  expect(response.status).toBe(422);
  expect((await pool.query("SELECT person_id FROM aliases WHERE alias = 'pak bud'")).rows).toEqual([
    { person_id: rina },
  ]);
  expect(
    (await pool.query('SELECT resolved_at FROM review_items WHERE id = $1', [pakBud])).rows,
  ).toEqual([{ resolved_at: null }]);
});
