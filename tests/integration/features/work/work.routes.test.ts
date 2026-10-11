import { beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { signInSeedAdmin } from '../../../helpers/admin-session.js';
import { createApp } from '../../../../src/app.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';

const pool = databaseFixture();
const now = new Date('2026-10-10T04:01:00Z');
let app: ReturnType<typeof createApp>;
let cookie: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => now }));
  const session = await signInSeedAdmin(pool, {
    id: 'work-admin',
    email: 'work@pointstar.example',
  });

  cookie = session.cookie;
  app = createApp('api', undefined, undefined, {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
    work: { now: () => now },
  });
});

test('GET /work?status=stalled for the seed returns exactly ORD-0091', async () => {
  const response = await request(app).get('/api/v1/work?status=stalled').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data).toHaveLength(1);
  expect(response.body.data[0]).toMatchObject({
    displayId: 'ORD-0091',
    status: 'stalled',
    customer: 'Mrs. Sri',
    category: 'Order',
    owner: { name: 'Budi Santoso', team: 'Warehouse' },
    channel: { displayName: 'Warehouse & Shipping' },
  });
  expect(response.body.page).toEqual({ total: 1, nextCursor: null });
  expect(JSON.stringify(response.body)).not.toContain('body_safe');
});

test('Work pagination keeps newest activity first, excludes repeats, and binds its cursor to the filter', async () => {
  const first = await request(app).get('/api/v1/work?limit=2').set('Cookie', cookie);

  expect(first.status).toBe(200);
  expect(first.body.data).toHaveLength(2);
  expect(first.body.page.total).toBeGreaterThan(2);
  expect(first.body.page.nextCursor).toEqual(expect.any(String));
  const second = await request(app)
    .get('/api/v1/work')
    .query({ limit: 2, cursor: first.body.page.nextCursor })
    .set('Cookie', cookie);

  expect(second.status).toBe(200);
  expect(second.body.page.total).toBe(first.body.page.total);
  expect(second.body.data.map((item: { displayId: string }) => item.displayId)).not.toContain(
    first.body.data[0].displayId,
  );
  expect(Date.parse(second.body.data[0].lastActivityAt)).toBeLessThanOrEqual(
    Date.parse(first.body.data[1].lastActivityAt),
  );
  const mismatch = await request(app)
    .get('/api/v1/work')
    .query({ status: 'stalled', cursor: first.body.page.nextCursor })
    .set('Cookie', cookie);

  expect(mismatch.status).toBe(422);
});

test('Work search is case-insensitive and reports the total for its filter', async () => {
  const response = await request(app)
    .get('/api/v1/work')
    .query({ q: 'ord-0091' })
    .set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data.map((item: { displayId: string }) => item.displayId)).toEqual([
    'ORD-0091',
  ]);
  expect(response.body.page.total).toBe(1);
});

test.each([
  { status: 'unknown' },
  { limit: 101 },
  { cursor: 'not-a-cursor' },
  { q: 'a'.repeat(101) },
  { workspaceId: 'foreign' },
])('Work rejects invalid query %j', async (query) => {
  const response = await request(app).get('/api/v1/work').query(query).set('Cookie', cookie);

  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe('E-VALIDATION');
});
