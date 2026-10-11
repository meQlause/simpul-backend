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
import { schemaVersion } from '../../../../src/platform/db/migrate-tenant.js';

const system = databaseFixture(2);
const customer = databaseFixture(2, { tls: true, passwordAuth: true });
const mirror = databaseFixture(2, { tls: true, passwordAuth: true });
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
    const selected = config.database === 'mirror' ? mirror : pool;
    const target = new URL(selected.options.connectionString!);
    const connection = new postgres.Pool({
      ...config,
      host: target.hostname,
      port: Number(target.port),
      database: 'postgres',
      ssl: { ...(config.ssl as object), ca: selected.certificate() },
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
      invalidate: resolveConnection.close,
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

test('FR-DB-08: pending database metadata is readable before any customer connection exists', async () => {
  const response = await supertest(api(customer).app).get('/api/v1/database').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    data: {
      mode: 'own',
      status: 'pending',
      host: null,
      port: null,
      databaseName: null,
      schemaVersion: null,
      availabilityAckAt: null,
      connectedAt: null,
      unreachableSince: null,
    },
  });
});

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
  expect((await customer.query('SELECT id FROM people')).rows).toHaveLength(1);
  expect(
    (await customer.query('SELECT id FROM config_audit WHERE table_name = $1', ['workspaces']))
      .rows,
  ).toHaveLength(1);
}

async function interruptSystemCommit(app: ReturnType<typeof createApp>, body: object) {
  await system.query(`CREATE FUNCTION interrupt_database_setup() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated process failure after customer commit'; END $$;
    CREATE TRIGGER interrupt_database_setup BEFORE INSERT ON secrets
    FOR EACH ROW EXECUTE FUNCTION interrupt_database_setup()`);

  try {
    const response = await supertest(app).put('/api/v1/database').set('Cookie', cookie).send(body);

    expect(response.status).toBe(500);
    expect((await customer.query('SELECT id FROM workspaces')).rows).toEqual([{ id: workspaceId }]);
    expect(
      (await system.query('SELECT status, url_secret_ref FROM workspace_databases')).rows,
    ).toEqual([{ status: 'pending', url_secret_ref: null }]);
    expect((await system.query('SELECT id FROM secrets')).rows).toEqual([]);
    expect((await system.query('SELECT workspace_id FROM workspace_keys')).rows).toEqual([]);
  } finally {
    await system.query(
      'DROP TRIGGER interrupt_database_setup ON secrets; DROP FUNCTION interrupt_database_setup()',
    );
  }
}

test('An identical PUT /database after a crash between databases completes setup and GET /me answers 200 (data-spec §5.16; FR-DB-04)', async () => {
  const { app, resolveConnection } = api(customer);
  const connectionString =
    'postgres://postgres:test-only-db-password@customer.example/postgres?sslmode=require';
  const body = { connectionString, availabilityAck: true };

  await interruptSystemCommit(app, body);
  const response = await supertest(app).put('/api/v1/database').set('Cookie', cookie).send(body);

  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    mode: 'own',
    status: 'connected',
    host: 'customer.example',
    port: 5432,
    databaseName: 'postgres',
    schemaVersion,
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

async function rejectEmptyReplacement(
  app: ReturnType<typeof createApp>,
  connectionString: string,
  closed: ReturnType<typeof vi.spyOn>,
) {
  const empty = await supertest(app)
    .put('/api/v1/database')
    .set('Cookie', cookie)
    .send({ connectionString });

  expect(empty.status).toBe(422);
  expect(empty.body.error.code).toBe('E-DB-WORKSPACE-MISMATCH');
  expect(closed).not.toHaveBeenCalled();
  expect((await system.query('SELECT database_name FROM workspace_databases')).rows).toEqual([
    { database_name: 'postgres' },
  ]);
}

async function verifyReplacement(app: ReturnType<typeof createApp>, connectionString: string) {
  const response = await supertest(app)
    .put('/api/v1/database')
    .set('Cookie', cookie)
    .send({ connectionString });

  expect(response.status).toBe(200);
  expect(response.body.data.databaseName).toBe('mirror');
  expect(response.body.data.availabilityAckAt).toBe('2026-10-11T12:00:00.000Z');
  const profile = await supertest(app).get('/api/v1/me').set('Cookie', cookie);

  expect(profile.status).toBe(200);
  const audit = (
    await mirror.query(
      "SELECT before, after FROM config_audit WHERE table_name = 'workspace_databases'",
    )
  ).rows;

  expect(audit).toEqual([
    {
      before: { host: 'customer.example', port: 5432, databaseName: 'postgres' },
      after: { host: 'customer.example', port: 5432, databaseName: 'mirror' },
    },
  ]);
  expect(JSON.stringify(audit)).not.toContain('test-only-db-password');
  expect(
    (
      await supertest(app)
        .put('/api/v1/database')
        .set('Cookie', cookie)
        .send({ connectionString, availabilityAck: true })
    ).status,
  ).toBe(422);
}

test('FR-DB-07: replacement refuses an empty database, accepts a copy without acknowledgement, and closes the old pool', async () => {
  const { app, resolveConnection } = api(customer);
  const closed = vi.spyOn(await resolveConnection(workspaceId), 'end');
  const peer = api(customer);
  const peerClosed = vi.spyOn(await peer.resolveConnection(workspaceId), 'end');
  const connectionString =
    'postgres://postgres:test-only-db-password@customer.example/mirror?sslmode=require';

  await rejectEmptyReplacement(app, connectionString, closed);
  mirror.restore(customer.dump());
  await verifyReplacement(app, connectionString);
  expect(closed).toHaveBeenCalledTimes(1);
  expect((await supertest(peer.app).get('/api/v1/me').set('Cookie', cookie)).status).toBe(200);
  expect(peerClosed).toHaveBeenCalledTimes(1);
  await resolveConnection.close(workspaceId);
  await peer.resolveConnection.close(workspaceId);
});

test('FR-DB-08: GET /database returns only safe metadata even while the customer database is unreachable', async () => {
  const { app } = api(customer);
  const connected = await supertest(app).get('/api/v1/database').set('Cookie', cookie);

  expect(connected.status).toBe(200);
  expect(connected.body.data).toEqual({
    mode: 'own',
    status: 'connected',
    host: 'customer.example',
    port: 5432,
    databaseName: 'mirror',
    schemaVersion,
    availabilityAckAt: '2026-10-11T12:00:00.000Z',
    connectedAt: '2026-10-11T12:00:00.000Z',
    unreachableSince: null,
  });
  await system.query(
    "UPDATE workspace_databases SET status = 'unreachable', unreachable_since = $1 WHERE workspace_id = $2",
    ['2026-10-11T13:00:00Z', workspaceId],
  );
  const outage = await supertest(app).get('/api/v1/database').set('Cookie', cookie);

  expect(outage.status).toBe(200);
  expect(outage.body.data).toEqual({
    ...connected.body.data,
    status: 'unreachable',
    unreachableSince: '2026-10-11T13:00:00.000Z',
  });
  expect(outage.text).not.toContain('postgres:');
  expect(outage.text).not.toContain('test-only-db-password');
});
