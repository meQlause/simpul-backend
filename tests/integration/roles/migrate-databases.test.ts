import postgres from 'pg';
import { beforeAll, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../helpers/database.js';
import { migrateTenant, schemaVersion } from '../../../src/platform/db/migrate-tenant.js';
import { scopedTransaction } from '../../../src/platform/db/scoped-transaction.js';
import { createSecretStore } from '../../../src/platform/secrets/index.js';
import { provisionAdmin } from '../../../src/features/auth/index.js';
import { createConnectionResolver } from '../../../src/platform/db/connection-resolver.js';
import { migrateDatabases } from '../../../src/roles/migrate-databases.js';
import addresses from '../../fixtures/host-addresses.json' with { type: 'json' };
import { createWorkspace } from '../../../src/features/workspace/index.js';

const system = databaseFixture(3);
const broken = databaseFixture(2, { tls: true });
const healthy = databaseFixture(2, { tls: true });
const secretStore = createSecretStore(Buffer.alloc(32, 7).toString('base64'));
const brokenId = '00000000-0000-4000-8000-000000100001';
const healthyId = '00000000-0000-4000-8000-000000100002';
const now = new Date('2026-10-11T15:00:00Z');
const sendMail = vi.fn(async (_message: unknown) => {});
const alert = vi.fn();
const openPool = vi.fn((config: postgres.PoolConfig) => {
  const selected = config.database === 'broken' ? broken : healthy;
  const target = new URL(selected.options.connectionString!);

  return new postgres.Pool({
    ...config,
    host: target.hostname,
    port: Number(target.port),
    database: 'postgres',
    ssl: { ...(config.ssl as object), ca: selected.certificate() },
  });
});
const services = {
  systemPool: system,
  secretStore,
  now: () => now,
  sendMail,
  alert,
  systemHost: 'system.example',
  openPool,
  lookup: async (host: string) => [
    {
      address: host === 'system.example' ? addresses.systemAddress : addresses.publicAddress,
      family: 4,
    },
  ],
};

async function registerDatabase(workspaceId: string, name: string) {
  await scopedTransaction(
    async () => system,
    workspaceId,
    async (tx) => {
      await provisionAdmin(tx, {
        id: name,
        email: `${name}@example.test`,
        name,
        token: name,
        now,
        expiresAt: new Date('2099-01-01'),
      });
      const ref = await secretStore.put(tx, workspaceId, {
        purpose: 'database_url',
        value: `postgres://postgres:private@customer.example/${name}?sslmode=require`,
      });

      await tx.query(
        `INSERT INTO workspace_databases (workspace_id, workspace_name, timezone, admin_auth_user_id, status,
      url_secret_ref, host, schema_version, availability_ack_at) VALUES ($1, $2, 'Asia/Jakarta', $2, 'connected', $3,
      'customer.example', '0014_global_bot_claims', $4)`,
        [workspaceId, name, ref, now],
      );
    },
  );
}

beforeAll(async () => {
  await scopedTransaction(async () => system, brokenId, migrateTenant);
  await scopedTransaction(async () => broken, brokenId, migrateTenant);
  await scopedTransaction(async () => healthy, healthyId, migrateTenant);
  await seedBusiness(broken, brokenId);
  await seedBusiness(healthy, healthyId);
  await healthy.query(
    "DROP FUNCTION own_database_probes(); DELETE FROM simpul_schema_migrations WHERE tag = '0015_database_probes'",
  );
  await broken.query(
    "UPDATE simpul_schema_migrations SET hash = 'tampered' WHERE tag = '0001_schema'",
  );
  await registerDatabase(brokenId, 'broken');
  await registerDatabase(healthyId, 'healthy');
}, 120000);

async function seedBusiness(pool: postgres.Pool, workspaceId: string) {
  await createWorkspace(createConnectionResolver(pool), {
    workspaceId,
    adminId: workspaceId,
    authUserId: workspaceId,
    token: workspaceId,
    now,
    expiresAt: new Date('2099-01-01'),
    input: {
      name: 'Customer',
      'admin-name': 'Admin',
      'admin-email': 'admin@example.test',
      timezone: 'Asia/Jakarta',
    },
  });
}

test('NFR-DB-06: deployment marks one failed own migration, emails its admin, and continues migrating the others', async () => {
  expect(await migrateDatabases(services)).toEqual([brokenId]);
  expect(
    (
      await system.query(
        'SELECT workspace_id, status, schema_version FROM workspace_databases ORDER BY workspace_id',
      )
    ).rows,
  ).toEqual([
    {
      workspace_id: brokenId,
      status: 'migration_failed',
      schema_version: '0014_global_bot_claims',
    },
    { workspace_id: healthyId, status: 'connected', schema_version: schemaVersion },
  ]);
  expect(
    (await healthy.query('SELECT tag FROM simpul_schema_migrations ORDER BY tag DESC LIMIT 1'))
      .rows[0].tag,
  ).toBe(schemaVersion);
  expect(
    (await healthy.query("SELECT to_regprocedure('own_database_probes()') AS routine")).rows[0]
      .routine,
  ).not.toBeNull();
  expect(sendMail).toHaveBeenCalledTimes(1);
  expect(sendMail).toHaveBeenCalledWith(
    expect.objectContaining({
      to: 'broken@example.test',
      subject: 'Simpul cannot reach your database',
    }),
  );
  expect(JSON.stringify([sendMail.mock.calls, alert.mock.calls])).not.toContain('private');
});

test('NFR-DB-06: a process refuses an own schema version different from its built version before opening a pool', async () => {
  await system.query(
    "UPDATE workspace_databases SET schema_version = 'future' WHERE workspace_id = $1",
    [healthyId],
  );
  const resolve = createConnectionResolver(system, services);

  await expect(resolve(healthyId)).rejects.toMatchObject({ code: 'E-DB-UNAVAILABLE' });
  expect(openPool).not.toHaveBeenCalled();
});
