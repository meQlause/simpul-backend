import { randomUUID, randomBytes } from 'node:crypto';
import { beforeAll, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createConnectionResolver } from '../../src/platform/db/connection-resolver.js';
import { createConnectionLookup } from '../../src/platform/db/connection-lookup.js';
import { createSecretStore } from '../../src/platform/secrets/index.js';
import {
  createTelegramProvider,
  type ActivationProvider,
} from '../../src/platform/providers/index.js';
import { databaseFixture } from './database.js';
import { applyMigrations } from './migrations.js';
import { signInSeedAdmin } from './admin-session.js';
import { loadPointStarSeed, pointStarSeed } from '../fixtures/point-star.js';

export const pool = databaseFixture(2);
const now = new Date('2026-10-10T04:01:00Z');
const keys = ['bot_identity', 'group', 'membership', 'privacy_mode', 'webhook', 'inbound'];
const checks = keys.map((key) => ({
  key,
  status: 'pass' as const,
  message: 'Test check',
  action: null,
}));
export const provider = {
  verifyCredential: vi.fn(async (_credential: string) => ({
    providerAccountId: 'activation-test-bot',
    botUsername: 'test_bot',
    botName: 'Test bot',
    canJoinGroups: true,
    privacyModeOk: true,
  })),
  registerWebhook: vi.fn(async () => {}),
  checkReadiness: vi.fn(async () => checks),
  describeChat: async () => ({ chatType: 'supergroup' as const, title: 'Test group' }),
  send: vi.fn<ActivationProvider['send']>(async () => ({ providerMessageId: 'test-indicator' })),
};
export let app: ReturnType<typeof createApp>;
export let webhookApp: ReturnType<typeof createApp>;
export const webhookSecret = randomBytes(32).toString('base64url');
export let cookie: string;
let connectionId: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => now }));
  await pool.query('TRUNCATE bot_connections CASCADE');
  const session = await signInSeedAdmin(pool, {
    id: 'activation-admin',
    email: 'activation@pointstar.example',
  });
  cookie = session.cookie;
  const services = {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
    telegram: provider,
    connectionSetup: {
      masterKey: Buffer.alloc(32, 7).toString('base64'),
      publicBaseUrl: 'https://simpul.example',
      now: () => now,
      newId: randomUUID,
      newWebhookSecret: () => webhookSecret,
      newCode: () => randomBytes(16).toString('hex'),
    },
  };
  app = createApp('api', undefined, undefined, services);
  webhookApp = createApp('webhook', undefined, undefined, {
    ...services,
    webhook: {
      resolveConnection: services.resolveConnection,
      lookupConnection: createConnectionLookup(pool),
      secretStore: createSecretStore(services.connectionSetup.masterKey),
      provider: createTelegramProvider('https://telegram.example', vi.fn<typeof fetch>()),
      now: () => now,
    },
  });
  const connection = await request(app)
    .post('/api/v1/telegram/connections')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'activation-bot')
    .send({ connectionName: 'Activation bot', botToken: 'test-only-activation-token' });
  expect(connection.status).toBe(201);
  connectionId = connection.body.data.id;
}, 120000);

export async function draftWithVerification(scenario: string) {
  const id = randomUUID();
  const numericId = BigInt('0x' + id.replaceAll('-', '').slice(0, 10));
  const draft = await request(app)
    .post('/api/v1/channels')
    .set('Cookie', cookie)
    .send({
      botConnectionId: connectionId,
      providerChatId: `-${numericId}`,
      displayName: scenario,
    });
  expect(draft.status).toBe(201);
  const expired = scenario === 'verification-expired';
  const ready = scenario !== 'readiness-incomplete';
  await pool.query(
    `INSERT INTO channel_verifications (id, workspace_id, channel_id, bot_connection_id, config_version, credential_version, checks, status, checked_at, expires_at)
     SELECT $1, workspace_id, id, bot_connection_id, 1, 1, $3, $4, $5, $6 FROM channels WHERE id = $2`,
    [
      id,
      draft.body.data.id,
      JSON.stringify(
        ready
          ? checks
          : checks.map((check) => ({
              ...check,
              status: check.key === 'inbound' ? 'pending' : 'pass',
            })),
      ),
      ready ? 'pass' : 'fail',
      expired ? '2026-10-10T03:51:00Z' : '2026-10-10T04:00:00Z',
      expired ? '2026-10-10T04:01:00Z' : '2026-10-10T04:10:00Z',
    ],
  );
  return { channelId: draft.body.data.id as string, verificationId: id };
}
