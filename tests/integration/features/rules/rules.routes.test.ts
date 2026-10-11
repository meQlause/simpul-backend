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
    id: 'rules-admin',
    email: 'rules@pointstar.example',
  });

  cookie = session.cookie;
  app = createApp('api', undefined, undefined, {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
    rules: { now: () => now },
  });
}, 120000);

test('Rules §1: GET /rules returns seed matches30d 64,48,22,8,6,4,10,3 and weeklyEstimate 15,11,5,2,1,1,2,1', async () => {
  const response = await request(app).get('/api/v1/rules').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data.map((rule: { matches30d: number }) => rule.matches30d)).toEqual([
    64, 48, 22, 8, 6, 4, 10, 3,
  ]);
  expect(response.body.data.map((rule: { weeklyEstimate: number }) => rule.weeklyEstimate)).toEqual(
    [15, 11, 5, 2, 1, 1, 2, 1],
  );
  expect(response.body.data[0]).toMatchObject({
    name: 'New orders reach the warehouse',
    category: { name: 'Order' },
    eventType: 'new',
    conditionText: 'A new order has been confirmed',
    recipient: { team: 'Warehouse', holderName: 'Budi Santoso' },
    historyMode: 'digest',
    active: true,
    corrections30d: 0,
    correctionRate: '0',
  });
});

test('Rules §1: unauthenticated requests cannot read configuration', async () => {
  expect((await request(app).get('/api/v1/rules')).status).toBe(401);
});
