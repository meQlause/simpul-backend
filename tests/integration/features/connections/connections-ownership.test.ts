import express from 'express';
import postgres from 'pg';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import addresses from '../../../fixtures/host-addresses.json' with { type: 'json' };
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { scopedTransaction } from '../../../../src/platform/db/scoped-transaction.js';
import { schemaVersion } from '../../../../src/platform/db/migrate-tenant.js';
import { createSecretStore } from '../../../../src/platform/secrets/index.js';
import { connectionsRouter } from '../../../../src/features/connections/index.js';
import { errorHandler } from '../../../../src/platform/http/error-handler.js';
import { createAccountClaims } from '../../../../src/platform/db/connection-claims.js';

const system = databaseFixture(4);
const customer = databaseFixture(4, { tls: true });
const workspaces = { hosted: randomUUID(), first: randomUUID(), second: randomUUID() };
const actorId = randomUUID();
const secretStore = createSecretStore(Buffer.alloc(32, 9).toString('base64'));
const resolve = createConnectionResolver(system, {
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
let second: postgres.Pool;
const provider = {
  verifyCredential: vi.fn(async (credential: string) => ({
    providerAccountId: credential,
    botUsername: 'ownership_bot',
    botName: 'Ownership bot',
    canJoinGroups: true,
    privacyModeOk: true,
  })),
  registerWebhook: vi.fn(async () => {}),
  checkReadiness: async () => [],
  describeChat: async () => ({ chatType: 'supergroup' as const, title: 'Group' }),
  send: async () => ({ providerMessageId: 'indicator' }),
};

async function seedWorkspace(pool: postgres.Pool, workspaceId: string) {
  await pool.query(
    "INSERT INTO workspaces (id, name, timezone) VALUES ($1, 'Ownership', 'Asia/Jakarta')",
    [workspaceId],
  );
  await pool.query("INSERT INTO people (id, workspace_id, name) VALUES ($1, $2, 'Admin')", [
    actorId,
    workspaceId,
  ]);
  await pool.query('UPDATE workspaces SET admin_person_id = $2 WHERE id = $1', [
    workspaceId,
    actorId,
  ]);
}

async function registerOwn(workspaceId: string, database: string) {
  await scopedTransaction(
    async () => system,
    workspaceId,
    async (tx) => {
      const ref = await secretStore.put(tx, workspaceId, {
        purpose: 'database_url',
        value: `postgres://postgres:fixture-secret@customer.example/${database}?sslmode=require`,
      });

      await tx.query(
        `INSERT INTO workspace_databases (workspace_id, workspace_name, timezone, admin_auth_user_id,
      status, url_secret_ref, availability_ack_at, schema_version) VALUES ($1, 'Ownership', 'Asia/Jakarta', $2,
      'connected', $3, now(), $4)`,
        [workspaceId, `admin:${workspaceId}`, ref, schemaVersion],
      );
    },
  );
}

beforeAll(async () => {
  await applyMigrations(system);
  await applyMigrations(customer);
  await customer.query('CREATE DATABASE second_customer');
  const connection = new URL(customer.options.connectionString!);

  connection.pathname = '/second_customer';
  second = new postgres.Pool({ connectionString: connection.toString() });
  await applyMigrations(second);
  await seedWorkspace(system, workspaces.hosted);
  await seedWorkspace(customer, workspaces.first);
  await seedWorkspace(second, workspaces.second);
  await registerOwn(workspaces.first, 'postgres');
  await registerOwn(workspaces.second, 'second_customer');
}, 120000);

beforeEach(async () => {
  provider.registerWebhook.mockReset();
  provider.registerWebhook.mockResolvedValue(undefined);
  await system.query('TRUNCATE connection_routes');

  for (const pool of [system, customer, second]) {
    await pool.query('TRUNCATE bot_connections CASCADE');
    await pool.query('DELETE FROM idempotency_keys');
  }
});
afterAll(async () => {
  await resolve.close(workspaces.first);
  await resolve.close(workspaces.second);
  await second?.end();
});

function api(workspaceId: string) {
  return express()
    .use(express.json())
    .use((_incoming, response, next) => {
      response.locals.scope = { workspaceId, actorId };
      next();
    })
    .use(
      '/api/v1',
      connectionsRouter(resolve, provider, {
        ...createAccountClaims(system),
        secretStore,
        publicBaseUrl: 'https://simpul.example',
        now: () => new Date('2026-10-11T10:00:00Z'),
        newId: randomUUID,
        newWebhookSecret: () => 'test-webhook-secret-with-more-than-32-characters',
        newCode: () => 'test-code',
      }),
    )
    .use(errorHandler);
}

function create(workspaceId: string, key: string = randomUUID()) {
  return request(api(workspaceId))
    .post('/api/v1/telegram/connections')
    .set('Idempotency-Key', key)
    .send({ connectionName: 'Ownership bot', botToken: 'shared-bot-account' });
}

test.each([
  ['hosted', 'first'],
  ['first', 'hosted'],
  ['first', 'second'],
  ['second', 'first'],
] as const)(
  'FR-TG-02: a bot connected in %s is refused in %s with 409 E-TG-BOT-IN-USE',
  async (origin, destination) => {
    expect((await create(workspaces[origin])).status).toBe(201);
    const verify = await request(api(workspaces[destination]))
      .post('/api/v1/telegram/connections/verify')
      .send({ botToken: 'shared-bot-account' });

    expect(verify.status).toBe(409);
    expect(verify.body.error.code).toBe('E-TG-BOT-IN-USE');
    const response = await create(workspaces[destination]);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('E-TG-BOT-IN-USE');
    expect(provider.registerWebhook).toHaveBeenCalledTimes(1);
  },
);

test.each([
  ['hosted', 'first'],
  ['first', 'second'],
] as const)(
  'FR-TG-02: concurrent claims in %s and %s have exactly one winner',
  async (first, other) => {
    const responses = await Promise.all([create(workspaces[first]), create(workspaces[other])]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(provider.registerWebhook).toHaveBeenCalledTimes(1);
  },
);

test('data-spec §5.16: a failed customer write releases its system route and the same request can retry', async () => {
  provider.registerWebhook.mockRejectedValueOnce(new Error('Provider unavailable'));
  expect((await create(workspaces.first, 'retry-claim')).status).toBe(500);
  expect((await system.query('SELECT bot_connection_id FROM connection_routes')).rows).toEqual([]);
  expect((await customer.query('SELECT id FROM bot_connections')).rows).toEqual([]);
  expect((await create(workspaces.first, 'retry-claim')).status).toBe(201);
  expect((await system.query('SELECT workspace_id FROM connection_routes')).rows).toEqual([
    { workspace_id: workspaces.first },
  ]);
});
