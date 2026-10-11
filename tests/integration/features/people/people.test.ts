import { beforeAll, expect, test } from 'vitest';
import supertest from 'supertest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { createApp } from '../../../../src/app.js';
import { createAuthentication, provisionAdmin } from '../../../../src/features/auth/index.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { resolveRoleRecipient } from '../../../../src/features/people/index.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000100001';
let app: ReturnType<typeof createApp>;
let cookie: string;
let budi: string;
let rina: string;
let siti: string;
let roleId: string;
let originChannelId: string;

async function prepareRecipientChain() {
  const people = await pool.query<{ id: string; name: string }>('SELECT id, name FROM people');

  budi = people.rows.find((person) => person.name === 'Budi Santoso')?.id ?? '';
  rina = people.rows.find((person) => person.name === 'Rina Anggraini')?.id ?? '';
  siti = people.rows.find((person) => person.name === 'Siti Aminah')?.id ?? '';
  roleId = (await pool.query<{ id: string }>("SELECT id FROM roles WHERE name = 'Warehouse Lead'"))
    .rows[0].id;
  originChannelId = (
    await pool.query<{ id: string }>('SELECT id FROM channels ORDER BY id LIMIT 1')
  ).rows[0].id;
  await pool.query(
    "UPDATE role_members SET person_id = $1 WHERE role_id = $2 AND kind = 'backup'",
    [rina, roleId],
  );
  await pool.query('UPDATE people SET manager_id = NULL WHERE id = $1', [budi]);
}

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') }));
  const client = await pool.connect();

  try {
    await provisionAdmin(client, {
      id: 'people-test-admin',
      name: 'Siti Aminah',
      email: 'siti@pointstar.example',
      token: 'people-test-password-token',
      now: new Date(),
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
  } finally {
    client.release();
  }

  await pool.query(
    "UPDATE people SET auth_user_id = 'people-test-admin' WHERE name = 'Siti Aminah'",
  );
  await prepareRecipientChain();
  const auth = createAuthentication(pool, {
    baseUrl: 'https://simpul.example',
    secret: 'test-only-auth-secret-with-more-than-32-characters',
  });

  await auth.api.resetPassword({
    body: { token: 'people-test-password-token', newPassword: 'test-password-123' },
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

test('PATCH /people/{id} changes availability immediately', async () => {
  const response = await supertest(app)
    .patch(`/api/v1/people/${budi}`)
    .set('Cookie', cookie)
    .send({ availability: 'leave' });

  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    id: budi,
    availability: 'leave',
    backup: { id: rina },
  });
  const resolveConnection = createConnectionResolver(pool);
  const resolve = () =>
    resolveRoleRecipient(resolveConnection, workspaceId, roleId, originChannelId);

  expect(await resolve()).toEqual({ kind: 'person', personId: rina, via: 'backup' });
  const backupAway = await supertest(app)
    .patch(`/api/v1/people/${rina}`)
    .set('Cookie', cookie)
    .send({ availability: 'leave' });

  expect(backupAway.status).toBe(200);
  expect(await resolve()).toEqual({ kind: 'person', personId: siti, via: 'admin' });
  const adminAway = await supertest(app)
    .patch(`/api/v1/people/${siti}`)
    .set('Cookie', cookie)
    .send({ availability: 'leave' });

  expect(adminAway.status).toBe(200);
  expect(await resolve()).toEqual({ kind: 'channel', channelId: originChannelId });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM config_audit WHERE table_name = 'people'",
      )
    ).rows,
  ).toEqual([{ count: 3 }]);
});

test('GET /people includes the complete known roster and roleless executive', async () => {
  const response = await supertest(app).get('/api/v1/people').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data).toHaveLength(5);
  expect(response.body.data).toContainEqual(
    expect.objectContaining({ name: 'Mr. Hendra', role: null, level: 'executive' }),
  );
});

test.each([
  ['roleName', '   '],
  ['availability', 'unknown'],
  ['managerId', '00000000-0000-4000-8000-000000999999'],
  ['backupPersonId', '00000000-0000-4000-8000-000000999999'],
])('invalid %s is rejected without an audit entry', async (field, value) => {
  const before = await pool.query('SELECT id FROM config_audit ORDER BY id');
  const response = await supertest(app)
    .patch(`/api/v1/people/${budi}`)
    .set('Cookie', cookie)
    .send({ [field]: value });

  expect(response.status).toBe(422);
  expect(response.body.error).toMatchObject({
    code: 'E-VALIDATION',
    details: [expect.objectContaining({ field })],
  });
  expect((await pool.query('SELECT id FROM config_audit ORDER BY id')).rows).toEqual(before.rows);
});

test.each(['managerId', 'backupPersonId'])('a self-reference in %s is refused', async (field) => {
  const response = await supertest(app)
    .patch(`/api/v1/people/${budi}`)
    .set('Cookie', cookie)
    .send({ [field]: budi });

  expect(response.status).toBe(422);
  expect(response.body.error.details).toEqual([{ field, issue: 'invalid' }]);
});

test('role, supervisor and backup edits persist together without changing the role id', async () => {
  const response = await supertest(app)
    .patch(`/api/v1/people/${budi}`)
    .set('Cookie', cookie)
    .send({ roleName: ' Warehouse Coordinator ', managerId: siti, backupPersonId: siti });

  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    role: { id: roleId, name: 'Warehouse Coordinator' },
    manager: { id: siti },
    backup: { id: siti },
  });
  expect(
    (
      await pool.query<{ person_id: string }>(
        "SELECT person_id FROM role_members WHERE role_id = $1 AND kind = 'backup'",
        [roleId],
      )
    ).rows,
  ).toEqual([{ person_id: siti }]);
});

test.each(['id', 'workspaceId', 'level'])(
  'PATCH /people refuses server-owned %s',
  async (field) => {
    const audit = await pool.query('SELECT id FROM config_audit ORDER BY id');
    const response = await supertest(app)
      .patch(`/api/v1/people/${budi}`)
      .set('Cookie', cookie)
      .send({ availability: 'available', [field]: 'client-owned-value' });

    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: 'E-VALIDATION',
      details: [{ field, issue: 'unknown' }],
    });
    expect((await pool.query('SELECT id FROM config_audit ORDER BY id')).rows).toEqual(audit.rows);
  },
);
