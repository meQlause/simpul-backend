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
    id: 'overview-admin',
    email: 'overview@pointstar.example',
  });

  cookie = session.cookie;
  app = createApp('api', undefined, undefined, {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
    overview: { now: () => now },
  });
}, 120000);

test('Workspace §2: GET /overview for the seed returns 1284, 48, 156, 7 with trendPercent 12.8', async () => {
  const response = await request(app).get('/api/v1/overview').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    period: 'today',
    messagesUnderstood: { count: 1284, trendPercent: '12.8' },
    activeWork: { count: 48, completedToday: 12 },
    updatesDelivered: { count: 156, recipients: 1, topRecipients: [{ name: 'Budi Santoso' }] },
    needsReview: { count: 7, byKind: { unrouted: 4, alias: 2, category: 1 }, areas: 3 },
  });
});

test('Workspace §2: period=week returns 8426 understood, 124 work touched and 984 delivered', async () => {
  const response = await request(app).get('/api/v1/overview?period=week').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    period: 'week',
    messagesUnderstood: { count: 8426, trendPercent: null },
    activeWork: { count: 124 },
    updatesDelivered: { count: 984 },
  });
});

test.each([{ period: 'month' }, { workspaceId: 'foreign' }, { period: ['today', 'week'] }])(
  'Workspace §2: invalid overview query %j is rejected',
  async (query) => {
    const response = await request(app).get('/api/v1/overview').query(query).set('Cookie', cookie);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('E-VALIDATION');
  },
);

test('Workspace §2: overview requires an authenticated admin', async () => {
  const response = await request(app).get('/api/v1/overview');

  expect(response.status).toBe(401);
});

test('Workspace §2: local-day boundaries exclude noise, unclassified units and tomorrow', async () => {
  const seed = pointStarSeed({ now: () => now });

  await pool.query(
    `INSERT INTO units (workspace_id, channel_id, text, triage_class, ts_first, ts_last)
    SELECT $1, md5('point-star-channel-2')::uuid, 'Boundary', classification, at, at
    FROM (VALUES
      ('EVENT', '2026-10-09T17:00:00Z'::timestamptz),
      ('EVENT', '2026-10-09T16:59:59Z'::timestamptz),
      ('EVENT', '2026-10-10T17:00:00Z'::timestamptz),
      ('NOISE', '2026-10-10T03:00:00Z'::timestamptz),
      (NULL, '2026-10-10T03:00:00Z'::timestamptz)
    ) AS samples(classification, at)`,
    [seed.workspaceId],
  );
  const response = await request(app).get('/api/v1/overview').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data.messagesUnderstood.count).toBe(1285);
});
