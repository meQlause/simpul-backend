import { beforeAll, expect, test } from 'vitest';
import supertest from 'supertest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { createApp } from '../../../../src/app.js';
import { createAuthentication, provisionAdmin } from '../../../../src/features/auth/index.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';

const pool = databaseFixture();
let auth: ReturnType<typeof createAuthentication>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') }));
  const client = await pool.connect();
  try {
    await provisionAdmin(client, {
      id: 'non-admin',
      name: 'Budi Santoso',
      email: 'budi@pointstar.example',
      token: 'non-admin-password-token',
      now: new Date(),
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
    await client.query("UPDATE people SET auth_user_id = 'non-admin' WHERE name = 'Budi Santoso'");
    await provisionAdmin(client, {
      id: 'workspace-admin',
      name: 'Siti Aminah',
      email: 'siti@pointstar.example',
      token: 'admin-password-token',
      now: new Date(),
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
    await client.query(
      "UPDATE people SET auth_user_id = 'workspace-admin' WHERE name = 'Siti Aminah'",
    );
  } finally {
    client.release();
  }
  auth = createAuthentication(pool, {
    baseUrl: 'https://simpul.example',
    secret: 'test-only-auth-secret-with-more-than-32-characters',
  });
  app = createApp('api', undefined, undefined, auth);
  await auth.api.resetPassword({
    body: { token: 'non-admin-password-token', newPassword: 'test-password-123' },
  });
  await auth.api.resetPassword({
    body: { token: 'admin-password-token', newPassword: 'test-password-123' },
  });
}, 120000);

test('GET /api/v1/me returns 401 E-AUTH-REQUIRED without a session', async () => {
  const response = await supertest(app).get('/api/v1/me');
  expect(response.status).toBe(401);
  expect(response.body.error.code).toBe('E-AUTH-REQUIRED');
});

test('GET /api/v1/me returns 403 E-FORBIDDEN for a signed-in non-admin', async () => {
  const login = await auth.api.signInEmail({
    body: { email: 'budi@pointstar.example', password: 'test-password-123' },
    asResponse: true,
  });
  const response = await supertest(app)
    .get('/api/v1/me')
    .set('Cookie', login.headers.get('set-cookie') ?? '');
  expect(response.status).toBe(403);
  expect(response.body.error.code).toBe('E-FORBIDDEN');
});

test('The workspace admin resolves to their own workspace and actor scope', async () => {
  const login = await auth.api.signInEmail({
    body: { email: 'siti@pointstar.example', password: 'test-password-123' },
    asResponse: true,
  });
  const person = await pool.query('SELECT id, workspace_id FROM people WHERE auth_user_id = $1', [
    'workspace-admin',
  ]);
  await expect(
    auth.resolveAdmin(new Headers({ cookie: login.headers.get('set-cookie') ?? '' })),
  ).resolves.toEqual({ actorId: person.rows[0].id, workspaceId: person.rows[0].workspace_id });
});
