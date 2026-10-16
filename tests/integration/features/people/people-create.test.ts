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
const andi = {
  name: 'Andi Pratama',
  telegramHandle: '@andi_sales',
  roleName: 'Sales Admin',
  team: 'Sales',
};
let app: ReturnType<typeof createApp>;
let cookie: string;
let siti: string;
let rina: string;
let originChannelId: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') }));
  const client = await pool.connect();

  try {
    await provisionAdmin(client, {
      id: 'people-create-admin',
      name: 'Siti Aminah',
      email: 'siti@pointstar.example',
      token: 'people-create-password-token',
      now: new Date(),
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
  } finally {
    client.release();
  }

  await pool.query(
    "UPDATE people SET auth_user_id = 'people-create-admin' WHERE name = 'Siti Aminah'",
  );
  siti = (await pool.query("SELECT id FROM people WHERE name = 'Siti Aminah'")).rows[0].id;
  rina = (await pool.query("SELECT id FROM people WHERE name = 'Rina Anggraini'")).rows[0].id;
  originChannelId = (await pool.query('SELECT id FROM channels ORDER BY id LIMIT 1')).rows[0].id;
  const auth = createAuthentication(pool, {
    baseUrl: 'https://simpul.example',
    secret: 'test-only-auth-secret-with-more-than-32-characters',
  });

  await auth.api.resetPassword({
    body: { token: 'people-create-password-token', newPassword: 'test-password-123' },
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

function postPerson(body: object) {
  return supertest(app).post('/api/v1/people').set('Cookie', cookie).send(body);
}

async function personId(name: string) {
  return (await pool.query<{ id: string }>('SELECT id FROM people WHERE name = $1', [name])).rows[0]
    .id;
}

test('AC1: POST /people creates the person with a role and a Telegram identity, and no sign-in', async () => {
  const accounts = await pool.query('SELECT id FROM account ORDER BY id');
  const response = await postPerson(andi);

  expect(response.status).toBe(201);
  expect(response.body.data).toMatchObject({
    name: 'Andi Pratama',
    availability: 'available',
    identities: [{ provider: 'telegram', handle: '@andi_sales' }],
    role: { name: 'Sales Admin', team: 'Sales' },
    manager: null,
    backup: null,
  });
  const listed = await supertest(app).get('/api/v1/people').set('Cookie', cookie);

  expect(listed.body.data).toContainEqual(
    expect.objectContaining({
      id: response.body.data.id,
      role: expect.objectContaining({ name: 'Sales Admin', team: 'Sales' }),
    }),
  );
  expect((await pool.query('SELECT id FROM account ORDER BY id')).rows).toEqual(accounts.rows);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM people WHERE name = 'Andi Pratama' AND auth_user_id IS NOT NULL",
      )
    ).rows,
  ).toEqual([]);
});

test.each([
  ['name', { ...andi, name: '' }],
  ['roleName', { ...andi, roleName: '   ' }],
  ['team', { ...andi, team: 'Marketing' }],
  ['telegramHandle', { ...andi, telegramHandle: 'abcd' }],
  ['telegramHandle', { ...andi, telegramHandle: 'a'.repeat(33) }],
  ['telegramHandle', { ...andi, telegramHandle: 'andi-sales' }],
])('AC2: POST /people refuses %s = %j with a 422 that names the field', async (field, body) => {
  const response = await postPerson(body);

  expect(response.status).toBe(422);
  expect(response.body.error).toMatchObject({
    code: 'E-VALIDATION',
    details: [expect.objectContaining({ field })],
  });
});

test('AC2: a handle without @ is stored with @', async () => {
  const response = await postPerson({ ...andi, name: 'Lina Ops', telegramHandle: 'lina_ops' });

  expect(response.status).toBe(201);
  expect(response.body.data.identities).toEqual([{ provider: 'telegram', handle: '@lina_ops' }]);
});

test('AC3: a username another active person holds is refused on POST and on PATCH, in any case', async () => {
  const posted = await postPerson({
    ...andi,
    name: 'Andi Duplicate',
    telegramHandle: 'ANDI_SALES',
  });

  expect(posted.status).toBe(422);
  expect(posted.body.error.details).toEqual([{ field: 'telegramHandle', issue: 'duplicate' }]);

  const patched = await supertest(app)
    .patch(`/api/v1/people/${await personId('Mr. Hendra')}`)
    .set('Cookie', cookie)
    .send({ telegramHandle: 'Andi_Sales' });

  expect(patched.status).toBe(422);
  expect(patched.body.error.details).toEqual([{ field: 'telegramHandle', issue: 'duplicate' }]);
});

test('AC3: the database refuses a second identity with the same username in any case', async () => {
  await expect(
    pool.query(
      `INSERT INTO person_identities (workspace_id, person_id, provider, handle)
       VALUES ($1, $2, 'telegram', '@ANDI_SALES')`,
      [workspaceId, await personId('Mr. Hendra')],
    ),
  ).rejects.toThrow(/identities_handle_uq/u);
});

test('AC4: a new username replaces the identity and clears its Telegram id; null removes it', async () => {
  const andiId = await personId('Andi Pratama');

  await pool.query("UPDATE person_identities SET external_id = '777001' WHERE person_id = $1", [
    andiId,
  ]);
  const changed = await supertest(app)
    .patch(`/api/v1/people/${andiId}`)
    .set('Cookie', cookie)
    .send({ telegramHandle: '@andi_field' });

  expect(changed.status).toBe(200);
  expect(changed.body.data.identities).toEqual([{ provider: 'telegram', handle: '@andi_field' }]);
  expect(
    (await pool.query('SELECT external_id FROM person_identities WHERE person_id = $1', [andiId]))
      .rows,
  ).toEqual([{ external_id: null }]);

  const removed = await supertest(app)
    .patch(`/api/v1/people/${andiId}`)
    .set('Cookie', cookie)
    .send({ telegramHandle: null });

  expect(removed.status).toBe(200);
  expect(removed.body.data.identities).toEqual([]);
});

test('AC5: a deactivated person leaves the list, frees the username, and their role goes to the backup', async () => {
  const andiId = await personId('Andi Pratama');
  const roleId = (
    await pool.query<{ id: string }>(
      "SELECT role_id AS id FROM role_members WHERE person_id = $1 AND kind = 'member'",
      [andiId],
    )
  ).rows[0].id;
  const backed = await supertest(app)
    .patch(`/api/v1/people/${andiId}`)
    .set('Cookie', cookie)
    .send({ backupPersonId: rina, telegramHandle: '@andi_sales' });

  expect(backed.status).toBe(200);

  const gone = await supertest(app)
    .patch(`/api/v1/people/${andiId}`)
    .set('Cookie', cookie)
    .send({ active: false });

  expect(gone.status).toBe(200);

  const listed = await supertest(app).get('/api/v1/people').set('Cookie', cookie);

  expect(listed.body.data.map((person: { id: string }) => person.id)).not.toContain(andiId);
  expect(
    (
      await pool.query(
        'SELECT count(*)::int AS count FROM person_identities WHERE person_id = $1',
        [andiId],
      )
    ).rows,
  ).toEqual([{ count: 0 }]);

  const reused = await postPerson({ ...andi, name: 'Andi Baru' });

  expect(reused.status).toBe(201);
  expect(
    await resolveRoleRecipient(
      createConnectionResolver(pool),
      workspaceId,
      roleId,
      originChannelId,
    ),
  ).toEqual({ kind: 'person', personId: rina, via: 'backup' });

  const later = await supertest(app)
    .patch(`/api/v1/people/${andiId}`)
    .set('Cookie', cookie)
    .send({ roleName: 'Sales Lead' });

  expect(later.status).toBe(404);
  expect(later.body.error.code).toBe('E-NOT-FOUND');
});

test('AC6: the workspace admin cannot be deactivated', async () => {
  const response = await supertest(app)
    .patch(`/api/v1/people/${siti}`)
    .set('Cookie', cookie)
    .send({ active: false });

  expect(response.status).toBe(422);
  expect(response.body.error.details).toEqual([{ field: 'active', issue: 'invalid' }]);
  expect((await pool.query('SELECT active FROM people WHERE id = $1', [siti])).rows).toEqual([
    { active: true },
  ]);
});
