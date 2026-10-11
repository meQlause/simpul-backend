import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../../../../src/app.js';
import { createAuthentication } from '../../../../src/features/auth/index.js';
import { createWorkspace } from '../../../../src/features/workspace/index.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';

const pool = databaseFixture();
const auth = createAuthentication(pool, {
  baseUrl: 'https://simpul.example',
  secret: 'test-only-auth-secret-with-more-than-32-characters',
});
const app = createApp('api', undefined, undefined, {
  authentication: auth,
  resolveConnection: createConnectionResolver(pool),
});
let cookie = '';

beforeAll(async () => {
  await applyMigrations(pool);
  await createWorkspace(createConnectionResolver(pool), {
    workspaceId: randomUUID(),
    adminId: randomUUID(),
    authUserId: randomUUID(),
    token: 'pending-admin',
    now: new Date(),
    expiresAt: new Date('2099-01-01'),
    input: {
      name: 'Pending workspace',
      'admin-name': 'Admin',
      'admin-email': 'pending@example.test',
      timezone: 'Asia/Jakarta',
      database: 'own',
    },
  });
  await auth.api.resetPassword({
    body: { token: 'pending-admin', newPassword: 'pending-password-123' },
  });
  const response = await auth.api.signInEmail({
    body: { email: 'pending@example.test', password: 'pending-password-123' },
    asResponse: true,
  });

  cookie = response.headers.get('set-cookie') ?? '';
  await pool.query('CREATE ROLE pending_app NOLOGIN NOSUPERUSER NOBYPASSRLS');
  await pool.query('GRANT USAGE ON SCHEMA public TO pending_app');
  await pool.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pending_app',
  );
  await pool.query('GRANT EXECUTE ON FUNCTION workspace_for_session(text) TO pending_app');
  await pool.query('SET ROLE pending_app');
}, 120000);

test.each([
  '/me',
  '/overview',
  '/people',
  '/settings',
  '/settings/mail',
  '/work',
  '/vocabulary',
  '/rules',
  '/review-items',
  '/decisions',
  '/previews/recipient',
])('A pending workspace receives 409 E-DB-SETUP-REQUIRED at GET %s (FR-DB-02)', async (path) => {
  const response = await supertest(app).get(`/api/v1${path}`).set('Cookie', cookie);

  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('E-DB-SETUP-REQUIRED');
});

test.each(['post', 'put', 'patch', 'delete'] as const)(
  'A pending workspace cannot bypass setup with %s /database or an unknown admin route (FR-DB-02)',
  async (method) => {
    const response = await supertest(app)[method]('/api/v1/unknown').set('Cookie', cookie).send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('E-DB-SETUP-REQUIRED');
  },
);

test.each([
  'not-a-url',
  'https://admin:password@db.example.test/simpul',
  'postgres://db.example.test/simpul',
  'postgres://admin:password@db.example.test/',
])(
  'PUT /database rejects malformed or incomplete connection strings: %s',
  async (connectionString) => {
    const response = await supertest(app)
      .put('/api/v1/database')
      .set('Cookie', cookie)
      .send({ connectionString, availabilityAck: true });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('E-VALIDATION');
    expect(response.text).not.toContain(connectionString);
  },
);

test('Only GET and PUT /database pass the pending setup gate; the session stays valid (FR-DB-02)', async () => {
  for (const method of ['get', 'put'] as const) {
    const response = await supertest(app)
      [method]('/api/v1/database')
      .set('Cookie', cookie)
      .send({});

    expect(response.status).not.toBe(403);
    expect(response.status).not.toBe(409);
    expect(response.status).not.toBe(401);
  }

  for (const method of ['post', 'patch', 'delete'] as const) {
    const response = await supertest(app)
      [method]('/api/v1/database')
      .set('Cookie', cookie)
      .send({});

    expect(response.status).toBe(409);
  }

  const anonymous = await supertest(app).get('/api/v1/database');

  expect(anonymous.status).toBe(401);
});

test.each([undefined, false, 'true', 1, null])(
  'PUT /database without literal availabilityAck true stores no secret (FR-DB-03): %s',
  async (availabilityAck) => {
    const response = await supertest(app).put('/api/v1/database').set('Cookie', cookie).send({
      connectionString: 'postgres://admin:password@db.example.test/simpul?sslmode=require',
      availabilityAck,
    });

    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: 'E-VALIDATION',
      details: [{ field: 'availabilityAck' }],
    });
    await pool.query('RESET ROLE');

    try {
      expect((await pool.query('SELECT id FROM secrets')).rows).toEqual([]);
      expect((await pool.query('SELECT workspace_id FROM workspace_keys')).rows).toEqual([]);
      expect(
        (await pool.query('SELECT status, availability_ack_at FROM workspace_databases')).rows,
      ).toEqual([{ status: 'pending', availability_ack_at: null }]);
    } finally {
      await pool.query('SET ROLE pending_app');
    }
  },
);
