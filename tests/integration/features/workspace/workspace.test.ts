import { beforeAll, expect, test } from 'vitest';
import supertest from 'supertest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { createApp } from '../../../../src/app.js';
import { createAuthentication, provisionAdmin } from '../../../../src/features/auth/index.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';

const pool = databaseFixture();
let app: ReturnType<typeof createApp>;
let cookie: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') }));
  const client = await pool.connect();
  try {
    await provisionAdmin(client, {
      id: 'seed-admin',
      name: 'Siti Aminah',
      email: 'siti@pointstar.example',
      token: 'seed-admin-password-token',
      now: new Date(),
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
    await client.query("UPDATE people SET auth_user_id = 'seed-admin' WHERE name = 'Siti Aminah'");
  } finally {
    client.release();
  }
  const auth = createAuthentication(pool, {
    baseUrl: 'https://simpul.example',
    secret: 'test-only-auth-secret-with-more-than-32-characters',
  });
  await auth.api.resetPassword({
    body: { token: 'seed-admin-password-token', newPassword: 'test-password-123' },
  });
  const login = await auth.api.signInEmail({
    body: { email: 'siti@pointstar.example', password: 'test-password-123' },
    asResponse: true,
  });
  cookie = login.headers.get('set-cookie') ?? '';
  app = createApp('api', undefined, undefined, {
    authentication: auth,
    resolveConnection: createConnectionResolver(pool),
  });
}, 120000);

test('GET /me for the seed returns counts members: 4, channels: 3, activeRules: 3', async () => {
  const response = await supertest(app).get('/api/v1/me').set('Cookie', cookie);
  expect(response.status).toBe(200);
  expect(response.body.data).toEqual({
    person: { id: expect.any(String), name: 'Siti Aminah', roleName: 'Operations Manager' },
    workspace: {
      id: '00000000-0000-4000-8000-000000100001',
      name: 'Point Star',
      descriptor: 'Operations workspace',
      timezone: 'Asia/Jakarta',
      onboardingCompletedAt: null,
      counts: { members: 4, channels: 3, activeRules: 3 },
    },
  });
});

test('PUT /settings with quietStart equal to quietEnd returns 422 E-SETTINGS-QUIET-HOURS-EQUAL', async () => {
  const response = await supertest(app)
    .put('/api/v1/settings')
    .set('Cookie', cookie)
    .send({ quietStart: '21:00', quietEnd: '21:00', budgetPerHour: 6, digestTime: '08:30' });
  expect(response.status).toBe(422);
  expect(response.body.error).toMatchObject({
    code: 'E-SETTINGS-QUIET-HOURS-EQUAL',
    message: 'Choose different start and end times.',
    details: [{ field: 'quietEnd', issue: 'invalid' }],
  });
});

test('PUT /settings with budgetPerHour: 0 returns 422 E-VALIDATION', async () => {
  const response = await supertest(app)
    .put('/api/v1/settings')
    .set('Cookie', cookie)
    .send({ quietStart: '21:00', quietEnd: '07:00', budgetPerHour: 0, digestTime: '08:30' });
  expect(response.status).toBe(422);
  expect(response.body.error).toMatchObject({
    code: 'E-VALIDATION',
    details: [{ field: 'budgetPerHour', issue: 'invalid' }],
  });
});

test('PUT /settings accepts a window crossing midnight, returns saved settings and writes one config audit row', async () => {
  const response = await supertest(app)
    .put('/api/v1/settings')
    .set('Cookie', cookie)
    .send({ quietStart: '22:00', quietEnd: '06:00', budgetPerHour: 8, digestTime: '09:00' });
  expect(response.status).toBe(200);
  expect(response.body.data).toEqual({
    quietStart: '22:00',
    quietEnd: '06:00',
    budgetPerHour: 8,
    digestTime: '09:00',
    holdSeconds: 60,
    timezone: 'Asia/Jakarta',
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM config_audit WHERE table_name = 'policies'",
      )
    ).rows,
  ).toEqual([{ count: 1 }]);
});

test.each(['id', 'workspaceId', 'level'])(
  'PUT /settings refuses server-owned %s',
  async (field) => {
    const audit = await pool.query('SELECT id FROM config_audit ORDER BY id');
    const response = await supertest(app)
      .put('/api/v1/settings')
      .set('Cookie', cookie)
      .send({
        quietStart: '21:00',
        quietEnd: '07:00',
        budgetPerHour: 6,
        digestTime: '08:30',
        [field]: 'client-owned-value',
      });
    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: 'E-VALIDATION',
      details: [{ field, issue: 'unknown' }],
    });
    expect((await pool.query('SELECT id FROM config_audit ORDER BY id')).rows).toEqual(audit.rows);
  },
);
