import postgres from 'pg';
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test, vi } from 'vitest';
import supertest from 'supertest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { createAuthentication } from '../../../../src/features/auth/index.js';
import { createWorkspace } from '../../../../src/features/workspace/index.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { createApp } from '../../../../src/app.js';
import { createSecretStore } from '../../../../src/platform/secrets/index.js';
import addresses from '../../../fixtures/host-addresses.json' with { type: 'json' };

const system = databaseFixture(2);
const customer = databaseFixture(2, { tls: true, passwordAuth: true });
const plain = databaseFixture();
const missingVector = databaseFixture(2, { image: 'postgres:16', tls: true });
const workspaceId = randomUUID();
const auth = createAuthentication(system, {
  baseUrl: 'https://simpul.example',
  secret: 'test-only-auth-secret-with-more-than-32-characters',
});
let cookie = '';

beforeAll(async () => {
  await applyMigrations(system);
  await createWorkspace(createConnectionResolver(system), {
    workspaceId,
    adminId: randomUUID(),
    authUserId: randomUUID(),
    token: 'database-admin',
    now: new Date(),
    expiresAt: new Date('2099-01-01'),
    input: {
      database: 'own',
      name: 'Customer',
      'admin-name': 'Admin',
      'admin-email': 'database@example.test',
      timezone: 'Asia/Jakarta',
    },
  });
  await auth.api.resetPassword({
    body: { token: 'database-admin', newPassword: 'database-password-123' },
  });
  const response = await auth.api.signInEmail({
    body: { email: 'database@example.test', password: 'database-password-123' },
    asResponse: true,
  });

  cookie = response.headers.get('set-cookie') ?? '';
  await customer.query(
    "CREATE ROLE restricted LOGIN NOSUPERUSER NOCREATEDB PASSWORD 'test-only-db-password'",
  );
  await customer.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
}, 120000);

async function objects(pool: postgres.Pool) {
  return (
    await pool.query(`SELECT 'extension' kind, extname name FROM pg_extension
    UNION ALL SELECT 'relation', n.nspname || '.' || c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT LIKE 'pg_%'
    AND n.nspname <> 'information_schema'
    UNION ALL SELECT 'type', n.nspname || '.' || t.typname FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname NOT LIKE 'pg_%'
    AND n.nspname <> 'information_schema'
    UNION ALL SELECT 'function', n.nspname || '.' || p.proname FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT LIKE 'pg_%'
    AND n.nspname <> 'information_schema' ORDER BY kind, name`)
  ).rows;
}

async function assertNoWrites(target: postgres.Pool, before: unknown) {
  expect(await objects(target)).toEqual(before);
  expect((await system.query('SELECT id FROM secrets')).rows).toEqual([]);
  expect((await system.query('SELECT availability_ack_at FROM workspace_databases')).rows).toEqual([
    { availability_ack_at: null },
  ]);
}

function api(
  pool: typeof customer,
  overrides: { refusedHost?: boolean; oldVersion?: boolean } = {},
) {
  const openPool = vi.fn((config: postgres.PoolConfig) => {
    const target = new URL(pool.options.connectionString!);
    const connection = new postgres.Pool({
      ...config,
      host: target.hostname,
      port: Number(target.port),
      ssl: { ...(config.ssl as object), ca: pool.certificate() },
    });

    if (overrides.oldVersion) {
      const query = connection.query.bind(connection);

      connection.query = ((text: string, values?: unknown[]) =>
        text.includes('server_version_num')
          ? Promise.resolve({ rows: [{ server_version_num: '140000' }] })
          : query(text, values)) as typeof connection.query;
    }

    return connection;
  });
  const address = overrides.refusedHost ? addresses.privateAddress : addresses.publicAddress;
  const lookup = async (host: string) => [
    { address: host === 'system.example' ? addresses.systemAddress : address, family: 4 },
  ];
  const masterKey = Buffer.alloc(32, 9).toString('base64');
  const resolveConnection = createConnectionResolver(system, {
    systemHost: 'system.example',
    secretStore: createSecretStore(masterKey),
    lookup,
    openPool,
  });
  const app = createApp('api', undefined, undefined, {
    authentication: createAuthentication(
      system,
      {
        baseUrl: 'https://simpul.example',
        secret: 'test-only-auth-secret-with-more-than-32-characters',
      },
      resolveConnection,
    ),
    resolveConnection,
    database: {
      systemPool: system,
      systemHost: 'system.example',
      masterKey,
      lookup,
      openPool,
      now: () => new Date('2026-10-11T12:00:00Z'),
    },
  });

  return { app, openPool, resolveConnection };
}

async function scenarioTarget(scenario: string) {
  const targets: Record<string, typeof customer> = {
    'no TLS': plain,
    'missing vector': missingVector,
  };
  const target = targets[scenario] ?? customer;

  if (scenario === 'another workspace') {
    await target.query('CREATE TABLE workspaces (id uuid PRIMARY KEY)');
    await target.query('INSERT INTO workspaces VALUES ($1)', [randomUUID()]);
  }

  return target;
}

test.each([
  ['refused host', 'E-DB-CONNECTION-FAILED'],
  ['no TLS', 'E-DB-CONNECTION-FAILED'],
  ['wrong password', 'E-DB-CONNECTION-FAILED'],
  ['PostgreSQL 14', 'E-DB-VERSION-UNSUPPORTED'],
  ['restricted role', 'E-DB-PERMISSION-MISSING'],
  ['missing vector', 'E-DB-VECTOR-MISSING'],
  ['another workspace', 'E-DB-IN-USE'],
])(
  'PUT /database: %s returns %s and leaves both databases unchanged (FR-DB-04)',
  async (scenario, code) => {
    const target = await scenarioTarget(scenario);
    const before = await objects(target);
    const { app, openPool } = api(target, {
      refusedHost: scenario === 'refused host',
      oldVersion: scenario === 'PostgreSQL 14',
    });
    const user = scenario === 'restricted role' ? 'restricted' : 'postgres';
    const password = scenario === 'wrong password' ? 'wrong-password' : 'test-only-db-password';
    const connectionString = `postgres://${user}:${password}@customer.example/postgres?sslmode=require`;
    const response = await supertest(app)
      .put('/api/v1/database')
      .set('Cookie', cookie)
      .send({ connectionString, availabilityAck: true });

    expect(response.status).toBe(code === 'E-DB-IN-USE' ? 409 : 422);
    expect(response.body.error.code).toBe(code);
    expect(response.text).not.toContain(connectionString);
    await assertNoWrites(target, before);

    if (scenario === 'refused host') {
      expect(openPool).not.toHaveBeenCalled();
    }

    if (scenario === 'another workspace') {
      await target.query('DROP TABLE workspaces');
    }
  },
);

async function verifyCustomerProvision(personId: string) {
  expect((await customer.query('SELECT id, admin_person_id FROM workspaces')).rows).toEqual([
    { id: workspaceId, admin_person_id: personId },
  ]);
  expect((await customer.query('SELECT auth_user_id FROM people')).rows).toEqual(
    (await system.query('SELECT admin_auth_user_id AS auth_user_id FROM workspace_databases')).rows,
  );

  for (const table of ['workspaces', 'people', 'policies', 'config_audit']) {
    expect((await system.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
  }

  expect((await customer.query('SELECT id FROM "user"')).rows).toEqual([]);
  expect(
    (await customer.query('SELECT "after" FROM config_audit ORDER BY created_at LIMIT 1')).rows[0]
      .after,
  ).toMatchObject({ availabilityAckAt: '2026-10-11T12:00:00.000Z' });
}

test('PUT /database migrates and provisions only the customer database, and GET /me answers 200 (FR-DB-04)', async () => {
  const { app, resolveConnection } = api(customer);
  const connectionString =
    'postgres://postgres:test-only-db-password@customer.example/postgres?sslmode=require';
  const response = await supertest(app)
    .put('/api/v1/database')
    .set('Cookie', cookie)
    .send({ connectionString, availabilityAck: true });

  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    mode: 'own',
    status: 'connected',
    host: 'customer.example',
    port: 5432,
    databaseName: 'postgres',
    schemaVersion: '0012_retention_edit_links',
    availabilityAckAt: '2026-10-11T12:00:00.000Z',
    unreachableSince: null,
  });
  expect(response.text).not.toContain(connectionString);
  const profile = await supertest(app).get('/api/v1/me').set('Cookie', cookie);

  expect(profile.status).toBe(200);
  expect(profile.body.data.workspace).toMatchObject({
    id: workspaceId,
    name: 'Customer',
    timezone: 'Asia/Jakarta',
  });
  expect(profile.body.data.person.name).toBe('Admin');
  await verifyCustomerProvision(profile.body.data.person.id);
  await resolveConnection.close(workspaceId);
});
