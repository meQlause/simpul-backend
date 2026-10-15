import postgres from 'pg';
import request from 'supertest';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createApp } from '../../../../src/app.js';
import { createConnectionLookup } from '../../../../src/platform/db/connection-lookup.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { scopedTransaction } from '../../../../src/platform/db/scoped-transaction.js';
import { createSecretStore } from '../../../../src/platform/secrets/index.js';
import { createFakeProvider } from '../../../helpers/providers/fake.js';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import addresses from '../../../fixtures/host-addresses.json' with { type: 'json' };
import { schemaVersion } from '../../../../src/platform/db/migrate-tenant.js';
import { createProviderRegistry } from '../../../../src/platform/providers/index.js';
import { createAuthentication } from '../../../../src/features/auth/index.js';
import { createQueue, publishCoalesce } from '../../../../src/platform/queue/index.js';
import { registerPipelineJobs } from '../../../../src/roles/worker.js';

const system = databaseFixture(4);
const firstOwn = databaseFixture(4, { tls: true, restartable: true });
const secondOwn = databaseFixture(4, { tls: true });
const now = new Date('2026-10-11T10:00:00Z');
const workspaces = {
  hosted: '00000000-0000-4000-8000-000000100011',
  first: '00000000-0000-4000-8000-000000100012',
  second: '00000000-0000-4000-8000-000000100013',
};
const seeds = {
  hosted: pointStarSeed({
    now: () => now,
    workspaceId: workspaces.hosted,
    botId: '24000000-0000-4000-8000-000000000011',
  }),
  first: pointStarSeed({
    now: () => now,
    workspaceId: workspaces.first,
    botId: '24000000-0000-4000-8000-000000000012',
  }),
  second: pointStarSeed({
    now: () => now,
    workspaceId: workspaces.second,
    botId: '24000000-0000-4000-8000-000000000013',
  }),
};
const secrets = createSecretStore(Buffer.alloc(32, 13).toString('base64'));
const secondPort = 5433;
const provider = createFakeProvider(async () => {});
const publishers = new Map<string, ReturnType<typeof publishCoalesce>>();
const resolve = createConnectionResolver(system, {
  systemHost: 'system.example',
  secretStore: secrets,
  lookup: async (host) => [
    {
      address: host === 'system.example' ? addresses.systemAddress : addresses.publicAddress,
      family: 4,
    },
  ],
  openPool: (config) => {
    const target = Number(config.port) === secondPort ? secondOwn : firstOwn;
    const address = new URL(target.options.connectionString!);

    return new postgres.Pool({
      ...config,
      host: address.hostname,
      port: Number(address.port),
      ssl: { ...(config.ssl as object), ca: target.certificate() },
    });
  },
});
const providers = createProviderRegistry([provider]);
const authentication = createAuthentication(system, {
  baseUrl: 'https://simpul.example',
  secret: 'test-only-auth-secret-with-more-than-32-characters',
});
const webhook = createApp('webhook', undefined, undefined, {
  authentication,
  resolveConnection: resolve,
  webhook: {
    resolveConnection: resolve,
    lookupConnection: createConnectionLookup(system, resolve),
    secretStore: secrets,
    providers,
    now: () => now,
    publish: (tx, payload) => publishers.get(payload.workspaceId)!(tx, payload),
  },
});
let stopped = false;
const queueHandles: Awaited<ReturnType<typeof createQueue>>[] = [];

beforeAll(prepareFixtures, 120000);

async function prepareFixtures() {
  await prepareDatabases();
  await seedWorkspaces();
  await configureProviders();
  await registerOwnDatabases();
  await registerRoutes();
  await startQueues();
}

async function prepareDatabases() {
  await Promise.all([
    applyMigrations(system),
    applyMigrations(firstOwn),
    applyMigrations(secondOwn),
  ]);
}

async function seedWorkspaces() {
  await Promise.all([
    loadPointStarSeed(system, seeds.hosted),
    loadPointStarSeed(firstOwn, seeds.first),
    loadPointStarSeed(secondOwn, seeds.second),
  ]);
}

async function configureProviders() {
  await Promise.all([
    configureProvider(system, seeds.hosted, 'hosted'),
    configureProvider(firstOwn, seeds.first, 'first-own'),
    configureProvider(secondOwn, seeds.second, 'second-own'),
  ]);
}

async function registerOwnDatabases() {
  await Promise.all([
    registerOwnDatabase(seeds.first, 5432),
    registerOwnDatabase(seeds.second, secondPort),
  ]);
}

async function registerRoutes() {
  for (const seed of [seeds.first, seeds.second]) {
    await system.query(
      `INSERT INTO connection_routes (bot_connection_id, workspace_id, provider, provider_account_id)
       VALUES ($1, $2, 'fake', $3)`,
      [seed.botId, seed.workspaceId, `account-${seed.workspaceId}`],
    );
  }
}

async function startQueues() {
  const hostedQueue = await createQueue(system);

  queueHandles.push(hostedQueue);
  const secondOwnQueue = await createQueue(secondOwn);

  queueHandles.push(secondOwnQueue);
  publishers.set(workspaces.hosted, publishCoalesce(hostedQueue, 0));
  publishers.set(workspaces.second, publishCoalesce(secondOwnQueue, 0));
  await registerPipelineJobs(hostedQueue, pipelineServices());
  await registerPipelineJobs(secondOwnQueue, pipelineServices());
}

afterAll(async () => {
  await Promise.all(queueHandles.map((queue) => queue.stop()));

  if (stopped) {
    firstOwn.startDatabase();
  }

  await Promise.all(
    [workspaces.first, workspaces.second].map((workspaceId) => resolve.close(workspaceId)),
  );
});

async function configureProvider(
  pool: postgres.Pool,
  seed: ReturnType<typeof pointStarSeed>,
  suffix: string,
) {
  await scopedTransaction(
    async () => pool,
    seed.workspaceId,
    async (tx) => {
      const tokenRef = await secrets.put(tx, seed.workspaceId, {
        purpose: 'bot_token',
        value: `token-${suffix}`,
      });
      const webhookRef = await secrets.put(tx, seed.workspaceId, {
        purpose: 'webhook_secret',
        value: `secret-${suffix}`,
      });

      await tx.query(
        `UPDATE bot_connections SET provider = 'fake', provider_account_id = $2,
          token_secret_ref = $3, webhook_secret_ref = $4 WHERE id = $1`,
        [seed.botId, `account-${seed.workspaceId}`, tokenRef, webhookRef],
      );
      await tx.query(
        `UPDATE channels SET provider = 'fake', provider_chat_id = $1
          WHERE id = md5('point-star-channel-2')::uuid`,
        [`room-${suffix}`],
      );
      await tx.query(`UPDATE person_identities SET provider = 'fake' WHERE workspace_id = $1`, [
        seed.workspaceId,
      ]);
      await tx.query('UPDATE policies SET hold_seconds = 0 WHERE workspace_id = $1', [
        seed.workspaceId,
      ]);
    },
  );
}

async function registerOwnDatabase(seed: ReturnType<typeof pointStarSeed>, port: number) {
  await scopedTransaction(
    async () => system,
    seed.workspaceId,
    async (tx) => {
      const ref = await secrets.put(tx, seed.workspaceId, {
        purpose: 'database_url',
        value: `postgres://postgres:fixture-secret@customer.example:${port}/postgres?sslmode=require`,
      });

      await tx.query(
        `INSERT INTO workspace_databases
          (workspace_id, workspace_name, timezone, admin_auth_user_id, status, url_secret_ref,
           host, port, database_name, schema_version, availability_ack_at)
         VALUES ($1, 'Point Star', 'Asia/Jakarta', $2, 'connected', $3,
           'customer.example', $4, 'postgres', $5, $6)`,
        [seed.workspaceId, `admin-${seed.workspaceId}`, ref, port, schemaVersion, now],
      );
    },
  );
}

test('T-DB-08: webhook ingestion remains within latency targets when another own database is stopped', async () => {
  await stopFirstDatabase();
  await expectFirstDatabaseUnavailable();
  await expectHealthyWebhookLatency();
}, 60000);

async function stopFirstDatabase() {
  await Promise.all([resolve(workspaces.first), resolve(workspaces.second)]);
  await resolve.close(workspaces.first);
  firstOwn.on('error', () => {});
  firstOwn.stopDatabase();
  stopped = true;
}

async function expectFirstDatabaseUnavailable() {
  await expect(
    scopedTransaction(resolve, workspaces.first, (tx) => tx.query('SELECT 1')),
  ).rejects.toMatchObject({ code: 'E-DB-UNAVAILABLE' });
}

async function expectHealthyWebhookLatency() {
  const [hosted, second] = await Promise.all([
    webhookLatencies('hosted'),
    webhookLatencies('second'),
  ]);

  expect(percentile95(hosted)).toBeLessThan(5000);
  expect(percentile95(second)).toBeLessThan(5000);
  const [hostedResolver, secondResolver] = await Promise.all([
    resolverLatencies(workspaces.hosted),
    resolverLatencies(workspaces.second),
  ]);

  expect(percentile95(hostedResolver)).toBeLessThan(300);
  expect(percentile95(secondResolver)).toBeLessThan(300);
}

async function webhookLatencies(target: 'hosted' | 'second') {
  const seed = seeds[target];
  const pool = target === 'hosted' ? system : secondOwn;
  const samples: number[] = [];

  for (let index = 0; index < 10; index += 1) {
    const messageId = `${target}-message-${index}`;
    const started = performance.now();
    const response = await request(webhook)
      .post(`/api/v1/webhooks/fake/${seed.botId}`)
      .set('X-Fake-Secret', `secret-${target === 'hosted' ? 'hosted' : 'second-own'}`)
      .send({
        eventId: `${target}-${index}`,
        room: `room-${target === 'hosted' ? 'hosted' : 'second-own'}`,
        messageId,
        author: 'fake-person',
        content: 'ORD-0091: the shipment is moving.',
        sentAt: now.getTime(),
      });

    expect(response.status).toBe(200);

    await vi.waitFor(
      async () => {
        const result = await pool.query(
          `SELECT l.id FROM labels l JOIN unit_messages um ON um.unit_id = l.unit_id
           JOIN messages_raw m ON m.id = um.message_id WHERE m.provider_msg_id = $1`,
          [messageId],
        );

        expect(result.rows.length).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 100 },
    );

    samples.push(performance.now() - started);
  }

  return samples;
}

function pipelineServices(): Parameters<typeof registerPipelineJobs>[1] {
  return {
    resolveConnection: resolve,
    providers,
    secretStore: secrets,
    now: () => new Date(now.getTime() + 12000),
    publicBaseUrl: 'https://simpul.example',
    debounceSeconds: 0,
    embedding: {
      embed: async () => Array.from({ length: 768 }, (_item, index) => (index === 0 ? 1 : 0)),
    },
    embeddingModel: 'embedding-model',
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
  };
}

async function resolverLatencies(workspaceId: string) {
  const samples: number[] = [];

  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();

    await scopedTransaction(resolve, workspaceId, (tx) => tx.query('SELECT 1'));
    samples.push(performance.now() - started);
  }

  return samples;
}

function percentile95(samples: number[]) {
  return [...samples].sort((first, next) => first - next)[Math.ceil(samples.length * 0.95) - 1];
}
