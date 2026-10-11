import postgres from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { databaseFixture as disposableDatabase } from './database.js';
import { applyMigrations } from './migrations.js';
import { createConnectionResolver as productionResolver } from '../../src/platform/db/connection-resolver.js';
import { createConnectionLookup as productionLookup } from '../../src/platform/db/connection-lookup.js';
import { scopedTransaction } from '../../src/platform/db/scoped-transaction.js';
import { createSecretStore } from '../../src/platform/secrets/index.js';
import { schemaVersion } from '../../src/platform/db/migrate-tenant.js';
import addresses from '../fixtures/host-addresses.json' with { type: 'json' };

type Fixture = {
  system: postgres.Pool;
  resolve: ReturnType<typeof productionResolver>;
  prepared: Map<string, Promise<void>>;
};
const fixtures = new WeakMap<postgres.Pool, Fixture>();
const masterKey = Buffer.alloc(32, 11).toString('base64');
const secretStore = createSecretStore(masterKey);
const connectionString =
  'postgres://postgres:fixture-secret@customer.example/postgres?sslmode=require';

export function databaseFixture(maxConnections = 1) {
  const own = process.env.PSPT_TEST_DATABASE_MODE === 'own';
  const customer = disposableDatabase(maxConnections, { tls: own });

  if (!own) {
    return customer;
  }

  const system = disposableDatabase(2);
  const resolve = productionResolver(system, {
    systemHost: 'system.example',
    secretStore,
    lookup: async (host) => [
      {
        address: host === 'system.example' ? addresses.systemAddress : addresses.publicAddress,
        family: 4,
      },
    ],
    openPool: (config) => {
      const target = new URL(customer.options.connectionString!);

      return new postgres.Pool({
        ...config,
        host: target.hostname,
        port: Number(target.port),
        ssl: { ...(config.ssl as object), ca: customer.certificate() },
      });
    },
  });

  fixtures.set(customer, { system, resolve, prepared: new Map() });
  beforeAll(() => applyMigrations(system), 120000);
  afterAll(async () => {
    const fixture = fixtures.get(customer)!;

    await Promise.all(
      [...fixture.prepared.keys()].map((workspaceId) => resolve.close(workspaceId)),
    );
  });

  return customer;
}

async function registerWorkspace(pool: postgres.Pool, fixture: Fixture, workspaceId: string) {
  const workspace = (
    await pool.query(
      `SELECT workspace.name, workspace.timezone, person.auth_user_id
    FROM workspaces workspace LEFT JOIN people person ON person.id = workspace.admin_person_id
    WHERE workspace.id = $1`,
      [workspaceId],
    )
  ).rows[0];

  if (!workspace) {
    return;
  }

  await scopedTransaction(
    async () => fixture.system,
    workspaceId,
    async (tx) => {
      const ref = await secretStore.put(tx, workspaceId, {
        purpose: 'database_url',
        value: connectionString,
      });

      await tx.query(
        `INSERT INTO workspace_databases (workspace_id, workspace_name, timezone,
      admin_auth_user_id, status, url_secret_ref, availability_ack_at, schema_version)
      VALUES ($1, $2, $3, $4, 'connected', $5, now(), $6)`,
        [
          workspaceId,
          workspace.name,
          workspace.timezone,
          workspace.auth_user_id ?? `fixture-admin:${workspaceId}`,
          ref,
          schemaVersion,
        ],
      );
    },
  );
}

export async function prepareDatabase(pool: postgres.Pool, workspaceId: string) {
  const fixture = fixtures.get(pool);

  if (fixture && !fixture.prepared.has(workspaceId)) {
    fixture.prepared.set(workspaceId, registerWorkspace(pool, fixture, workspaceId));
  }

  await fixture?.prepared.get(workspaceId);
}

export function systemDatabase(pool: postgres.Pool) {
  return fixtures.get(pool)?.system ?? pool;
}

export function createConnectionResolver(pool: postgres.Pool) {
  const resolve = fixtures.get(pool)?.resolve ?? productionResolver(pool);

  return async (workspaceId: string) => {
    await prepareDatabase(pool, workspaceId);

    return resolve(workspaceId);
  };
}

export async function seedConnectionRoutes(pool: postgres.Pool) {
  const fixture = fixtures.get(pool);

  if (!fixture) {
    return;
  }

  const connections = (
    await pool.query('SELECT id, workspace_id, provider, provider_account_id FROM bot_connections')
  ).rows;

  for (const row of connections) {
    await prepareDatabase(pool, row.workspace_id);
    await scopedTransaction(
      async () => fixture.system,
      row.workspace_id,
      (tx) =>
        tx.query(
          `INSERT INTO connection_routes
      (bot_connection_id, workspace_id, provider, provider_account_id) VALUES ($1, $2, $3, $4)
      ON CONFLICT (bot_connection_id) DO NOTHING`,
          [row.id, row.workspace_id, row.provider, row.provider_account_id],
        ),
    );
  }
}

export function createConnectionLookup(pool: postgres.Pool) {
  return productionLookup(systemDatabase(pool), createConnectionResolver(pool));
}
