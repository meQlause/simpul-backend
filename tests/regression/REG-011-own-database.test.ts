import request from 'supertest';
import postgres from 'pg';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { databaseFixture } from '../helpers/database.js';
import { applyMigrations } from '../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../fixtures/point-star.js';
import addresses from '../fixtures/host-addresses.json' with { type: 'json' };
import { createFakeProvider } from '../helpers/providers/fake.js';
import { createProviderRegistry } from '../../src/platform/providers/index.js';
import { createSecretStore } from '../../src/platform/secrets/index.js';
import { createConnectionResolver } from '../../src/platform/db/connection-resolver.js';
import { createConnectionLookup } from '../../src/platform/db/connection-lookup.js';
import { scopedTransaction } from '../../src/platform/db/scoped-transaction.js';
import { createQueue, publishCoalesce } from '../../src/platform/queue/index.js';
import { registerPipelineJobs } from '../../src/roles/worker.js';
import { createAuthentication } from '../../src/features/auth/index.js';
import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/platform/logger/index.js';
import { ownDatabaseQueues } from '../../src/platform/db/own-database-queues.js';
import { schemaVersion } from '../../src/platform/db/migrate-tenant.js';

const system = databaseFixture(3);
const customer = databaseFixture(5, { tls: true });
const instant = new Date('2026-10-10T04:00:00Z');
const seed = pointStarSeed({ now: () => instant });
const connectionString =
  'postgres://postgres:test-secret@customer.example/postgres?sslmode=require';
const secretStore = createSecretStore(Buffer.alloc(32, 5).toString('base64'));
const exchange = vi.fn(async (_payload: unknown) => {});
const alerts = vi.fn();
const providers = createProviderRegistry([createFakeProvider(exchange)]);
const tenantOptions = {
  systemHost: 'system.example',
  secretStore,
  lookup: async (host: string) => [
    {
      address: host === 'system.example' ? addresses.systemAddress : addresses.publicAddress,
      family: 4,
    },
  ],
  openPool: (config: postgres.PoolConfig) => {
    const target = new URL(customer.options.connectionString!);

    return new postgres.Pool({
      ...config,
      host: target.hostname,
      port: Number(target.port),
      ssl: { ...(config.ssl as object), ca: customer.certificate() },
    });
  },
};
const resolveConnection = createConnectionResolver(system, { ...tenantOptions, maxConnections: 3 });
let ownQueues: ReturnType<typeof ownDatabaseQueues>;
let queue: Awaited<ReturnType<typeof createQueue>>;
let source: { id: string; connectionId: string };

async function registerDatabase() {
  await scopedTransaction(
    async () => system,
    seed.workspaceId,
    async (tx) => {
      const ref = await secretStore.put(tx, seed.workspaceId, {
        purpose: 'database_url',
        value: connectionString,
      });

      await tx.query(
        `INSERT INTO workspace_databases
      (workspace_id, workspace_name, timezone, admin_auth_user_id, status, url_secret_ref,
      host, port, database_name, schema_version, availability_ack_at, availability_ack_by, connected_at)
      VALUES ($1, 'Point Star', 'Asia/Jakarta', 'own-admin', 'connected', $2,
      'customer.example', 5432, 'postgres', $4, $3, 'own-admin', $3)`,
        [seed.workspaceId, ref, instant, schemaVersion],
      );
      await tx.query(
        `INSERT INTO connection_routes (bot_connection_id, workspace_id, provider, provider_account_id)
      VALUES ($1, $2, 'fake', '240000000')`,
        [source.connectionId, seed.workspaceId],
      );
    },
  );
}

async function configureProvider() {
  await scopedTransaction(
    async () => customer,
    seed.workspaceId,
    async (tx) => {
      const token = await secretStore.put(tx, seed.workspaceId, {
        purpose: 'bot_token',
        value: 'fake-token',
      });
      const secret = await secretStore.put(tx, seed.workspaceId, {
        purpose: 'webhook_secret',
        value: 'fake-secret',
      });

      await tx.query(
        "UPDATE bot_connections SET provider = 'fake', token_secret_ref = $2, webhook_secret_ref = $3 WHERE id = $1",
        [source.connectionId, token, secret],
      );
      await tx.query(
        "UPDATE channels SET provider = 'fake', provider_chat_id = 'fake-room' WHERE id = $1",
        [source.id],
      );
      await tx.query("UPDATE person_identities SET provider = 'fake' WHERE workspace_id = $1", [
        seed.workspaceId,
      ]);
      await tx.query('UPDATE policies SET hold_seconds = 0 WHERE workspace_id = $1', [
        seed.workspaceId,
      ]);
    },
  );
}

beforeAll(async () => {
  await applyMigrations(system);
  await applyMigrations(customer);
  await loadPointStarSeed(customer, seed);
  source = (
    await customer.query(
      'SELECT id, bot_connection_id AS "connectionId" FROM channels WHERE id = md5(\'point-star-channel-2\')::uuid',
    )
  ).rows[0];
  await configureProvider();
  await registerDatabase();
  ownQueues = ownDatabaseQueues(system, {
    ...tenantOptions,
    alert: alerts,
    register: async (tenantQueue) => {
      queue = tenantQueue;
      await registerPipelineJobs(tenantQueue, {
        resolveConnection,
        providers,
        secretStore,
        now: () => new Date(instant.getTime() + 12000),
        publicBaseUrl: 'https://simpul.example',
        debounceSeconds: 0,
        audit: vi.fn(),
        alert: vi.fn(),
        transcriber: { transcribe: vi.fn(async () => '') },
        model: {
          generate: vi.fn(async (input) =>
            input.mode === 'triage'
              ? 'EVENT'
              : JSON.stringify({
                  operations: [
                    {
                      type: 'progress',
                      tense: 'sudah_terjadi',
                      confidence: 0.9,
                      evidenceMessageIds: input.context?.evidenceMessageIds ?? [],
                    },
                  ],
                }),
          ),
        },
      });
    },
  });
  await ownQueues.refresh();
}, 120000);

afterAll(async () => {
  await ownQueues?.stop();
  await resolveConnection.close(seed.workspaceId);
});

async function assertSystemIsolation(logs: string, response: string) {
  const tables = await system.query<{
    table_name: string;
  }>(`SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'workspace_id'
    AND table_name NOT IN ('workspace_databases', 'connection_routes', 'secrets', 'workspace_keys')`);

  for (const { table_name: table } of tables.rows) {
    expect(
      (
        await system.query(`SELECT workspace_id FROM "${table}" WHERE workspace_id = $1`, [
          seed.workspaceId,
        ])
      ).rows,
      table,
    ).toEqual([]);
  }

  expect((await system.query('SELECT id FROM workspaces')).rows).toEqual([]);
  expect((await system.query('SELECT purpose FROM secrets')).rows).toEqual([
    { purpose: 'database_url' },
  ]);
  expect((await system.query("SELECT to_regclass('pgboss.job') AS jobs")).rows).toEqual([
    { jobs: null },
  ]);
  const audit = JSON.stringify((await customer.query('SELECT * FROM config_audit')).rows);

  for (const output of [logs, response, audit]) {
    expect(output).not.toContain(connectionString);
    expect(output).not.toContain('test-secret');
  }
}

test('REG-011: a webhook reaches a sent notification with no system business row or exposed connection string (FR-DB-05)', async () => {
  const logs: string[] = [];
  const logger = createLogger('info', {
    write: (line: string) => {
      logs.push(line);
    },
  });
  const receiver = createApp('webhook', undefined, logger, {
    authentication: createAuthentication(system, {
      baseUrl: 'https://simpul.example',
      secret: 'test-only-auth-secret-with-more-than-32-characters',
    }),
    resolveConnection,
    webhook: {
      resolveConnection,
      secretStore,
      providers,
      lookupConnection: createConnectionLookup(system, resolveConnection),
      now: () => instant,
      publish: publishCoalesce(queue, 0),
    },
  });
  const response = await request(receiver)
    .post(`/api/v1/webhooks/fake/${source.connectionId}`)
    .set('X-Fake-Secret', 'fake-secret')
    .send({
      eventId: 'own-update',
      room: 'fake-room',
      messageId: 'own-message',
      author: 'fake-person',
      content: 'ORD-0091: the shipment is moving.',
      sentAt: instant.getTime(),
    });

  expect(response.status).toBe(200);
  await vi.waitFor(
    async () => {
      const result =
        await customer.query(`SELECT n.sent_at FROM notifications n JOIN labels l ON l.id = n.label_id
      JOIN unit_messages um ON um.unit_id = l.unit_id JOIN messages_raw m ON m.id = um.message_id
      WHERE m.provider_msg_id = 'own-message'`);

      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows.every((row) => row.sent_at instanceof Date)).toBe(true);
    },
    { timeout: 15000 },
  );
  expect(exchange).toHaveBeenCalled();
  expect(logs.length).toBeGreaterThan(0);
  await assertSystemIsolation(logs.join('\n'), response.text);
}, 20000);

test('NFR-DB-07: queue discovery isolates a wrong database and reconnects when the encrypted URL rotates', async () => {
  const previous = queue;
  const otherWorkspace = '00000000-0000-4000-8000-000000100002';

  await scopedTransaction(
    async () => system,
    otherWorkspace,
    async (tx) => {
      const ref = await secretStore.put(tx, otherWorkspace, {
        purpose: 'database_url',
        value: connectionString,
      });

      await tx.query(
        `INSERT INTO workspace_databases
      (workspace_id, workspace_name, timezone, admin_auth_user_id, status, url_secret_ref, availability_ack_at)
      VALUES ($1, 'Unavailable', 'Asia/Jakarta', 'other-admin', 'connected', $2, $3)`,
        [otherWorkspace, ref, instant],
      );
    },
  );
  await ownQueues.refresh();
  expect(queue).toBe(previous);
  expect(alerts).toHaveBeenCalledWith({ workspaceId: otherWorkspace, code: 'E-DB-UNAVAILABLE' });
  await scopedTransaction(
    async () => system,
    seed.workspaceId,
    async (tx) => {
      const ref = (
        await tx.query('SELECT url_secret_ref FROM workspace_databases WHERE workspace_id = $1', [
          seed.workspaceId,
        ])
      ).rows[0].url_secret_ref;

      await secretStore.put(tx, seed.workspaceId, {
        purpose: 'database_url',
        value: connectionString,
        id: ref,
      });
    },
  );
  await ownQueues.refresh();
  expect(queue).not.toBe(previous);
  expect(() => queue.emit('error', new Error(connectionString))).not.toThrow();
  expect(JSON.stringify(alerts.mock.calls)).not.toContain(connectionString);
}, 20000);
