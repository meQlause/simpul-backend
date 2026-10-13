import type { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { createSecretStore } from '../../src/platform/secrets/index.js';
import {
  createProviderRegistry,
  createTelegramProvider,
  type ProviderAdapter,
} from '../../src/platform/providers/index.js';
import { createConnectionResolver } from '../../src/platform/db/connection-resolver.js';
import { createConnectionLookup } from '../../src/platform/db/connection-lookup.js';

const masterKey = Buffer.alloc(32, 7).toString('base64');
const webhookSecret = Buffer.alloc(32, 8).toString('base64url');

async function credentialFixture(pool: Pool) {
  const row = (
    await pool.query<{
      workspaceId: string;
      id: string;
      providerAccountId: string;
      botUsername: string;
      botName: string;
    }>(
      `SELECT workspace_id AS "workspaceId",id,provider_account_id AS "providerAccountId",bot_username AS "botUsername",bot_name AS "botName" FROM bot_connections ORDER BY id LIMIT 1`,
    )
  ).rows[0];
  const store = createSecretStore(masterKey);
  const client = await pool.connect();

  try {
    const tokenRef = await store.put(client, row.workspaceId, {
      purpose: 'bot_token',
      value: 'browser-test-bot-token',
    });
    const webhookRef = await store.put(client, row.workspaceId, {
      purpose: 'webhook_secret',
      value: webhookSecret,
    });

    await client.query(
      'UPDATE bot_connections SET token_secret_ref = $2,webhook_secret_ref = $3 WHERE id = $1',
      [row.id, tokenRef, webhookRef],
    );
  } finally {
    client.release();
  }

  return row;
}

export async function browserChannels(pool: Pool) {
  const account = await credentialFixture(pool);
  const receiver = createTelegramProvider('https://telegram.example');
  const provider: ProviderAdapter = {
    ...receiver,
    async verifyCredential(token) {
      return {
        ...account,
        providerAccountId:
          token === 'different-bot-token' ? 'different-bot' : account.providerAccountId,
        canJoinGroups: true,
        privacyModeOk: true,
      };
    },
    registerWebhook: async () => {},
    describeChat: async (_connection, chatId) => ({
      chatType: 'supergroup',
      title:
        (
          await pool.query<{ display_name: string }>(
            'SELECT display_name FROM channels WHERE provider_chat_id = $1',
            [chatId],
          )
        ).rows[0]?.display_name ?? 'Browser test group',
    }),
    checkReadiness: async () =>
      ['bot_identity', 'group', 'membership', 'privacy_mode', 'webhook'].map((key) => ({
        key,
        status: 'pass',
        message: 'Provider check passed',
        action: null,
      })),
    send: async () => ({ providerMessageId: 'browser-indicator' }),
  };
  const now = () => new Date();

  return {
    telegram: provider,
    connectionSetup: {
      masterKey,
      publicBaseUrl: 'https://simpul.example',
      now,
      newId: randomUUID,
      newWebhookSecret: () => webhookSecret,
      newCode: () => randomBytes(16).toString('hex'),
    },
    webhook: {
      resolveConnection: createConnectionResolver(pool),
      lookupConnection: createConnectionLookup(pool),
      secretStore: createSecretStore(masterKey),
      providers: createProviderRegistry([provider]),
      now,
    },
  };
}
