import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { pool, webhookSecret } from '../../../helpers/channel-activation.js';
import { createApp } from '../../../../src/app.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { createConnectionLookup } from '../../../helpers/database-mode.js';
import { createSecretStore } from '../../../../src/platform/secrets/index.js';
import {
  createProviderRegistry,
  createTelegramProvider,
} from '../../../../src/platform/providers/index.js';
import { createQueue, publishStart } from '../../../../src/platform/queue/index.js';
import { answerStartUpdate } from '../../../../src/features/ingest/ingest.start.service.js';
import { createFakeProvider } from '../../../helpers/providers/fake.js';

const now = new Date('2026-10-17T09:00:00Z');
const day = 86400000;
const replies = {
  connected: "You're connected to Simpul. Notifications will arrive here.",
  taken: 'This Telegram account is already connected to someone else. Ask your admin.',
  invalid: 'This link is no longer valid. Ask your admin for a new one.',
  askAdmin: 'Ask your admin for an invite link to connect.',
};
let queue: Awaited<ReturnType<typeof createQueue>>;
let webhookApp: ReturnType<typeof createApp>;
let workspaceId: string;
let connectionId: string;
const sent: { chatId: string; text: string }[] = [];
const sendResult = vi.fn(async () => ({ providerMessageId: 'reply' }) as object);
const fake = createFakeProvider(async () => {});
const services = () => ({
  resolveConnection: createConnectionResolver(pool),
  now: () => now,
  secretStore: {
    ...createSecretStore(Buffer.alloc(32, 7).toString('base64')),
    get: async () => 't',
  },
  providers: createProviderRegistry([
    {
      ...fake,
      provider: 'telegram',
      send: async (_connection: unknown, message: { chatId: string; text: string }) => {
        sent.push({ chatId: message.chatId, text: message.text });

        return sendResult() as never;
      },
    },
  ]),
  publicBaseUrl: 'https://simpul.example',
});

beforeAll(async () => {
  const bot = (await pool.query('SELECT id, workspace_id FROM bot_connections LIMIT 1')).rows[0];

  workspaceId = bot.workspace_id;
  connectionId = bot.id;
  queue = await createQueue(pool);
  // The webhook role reads only `webhook`; the API services are not used.
  webhookApp = createApp('webhook', undefined, undefined, {
    webhook: {
      resolveConnection: createConnectionResolver(pool),
      lookupConnection: createConnectionLookup(pool),
      secretStore: createSecretStore(Buffer.alloc(32, 7).toString('base64')),
      providers: createProviderRegistry([
        createTelegramProvider('https://telegram.example', vi.fn<typeof fetch>()),
      ]),
      publishStart: publishStart(queue),
      now: () => now,
    },
  } as never);
});

afterAll(async () => {
  await queue?.stop();
});

const hash = (code: string) => createHash('sha256').update(code).digest();

async function addPerson(name: string, identity?: { handle?: string; externalId?: string }) {
  const id = (
    await pool.query<{ id: string }>(
      'INSERT INTO people (workspace_id, name) VALUES ($1, $2) RETURNING id',
      [workspaceId, name],
    )
  ).rows[0].id;

  if (identity) {
    await pool.query(
      `INSERT INTO person_identities (workspace_id, person_id, provider, handle, external_id)
      VALUES ($1, $2, 'telegram', $3, $4)`,
      [workspaceId, id, identity.handle ?? null, identity.externalId ?? null],
    );
  }

  return id;
}

async function addInvite(
  personId: string,
  code: string,
  input: { expiresAt?: Date; consumed?: boolean } = {},
) {
  const creator = (
    await pool.query('SELECT id FROM people WHERE workspace_id = $1 LIMIT 1', [workspaceId])
  ).rows[0].id;

  await pool.query(
    `INSERT INTO person_invites (workspace_id, person_id, bot_connection_id, code_hash, created_at, expires_at, consumed_at, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      workspaceId,
      personId,
      connectionId,
      hash(code),
      new Date(now.getTime() - day),
      input.expiresAt ?? new Date(now.getTime() + day),
      input.consumed ? now : null,
      creator,
    ],
  );
}

function start(sender: { id: string; handle?: string }, code?: string) {
  return answerStartUpdate(services(), {
    workspaceId,
    connectionId,
    chatId: sender.id,
    senderExternalId: sender.id,
    ...(sender.handle ? { senderHandle: sender.handle } : {}),
    ...(code ? { codeHash: hash(code).toString('hex') } : {}),
  });
}

async function identityOf(personId: string) {
  return (
    await pool.query(
      `SELECT external_id, handle, started_at IS NOT NULL AS started FROM person_identities
      WHERE person_id = $1 AND provider = 'telegram'`,
      [personId],
    )
  ).rows;
}

function lastReply() {
  return sent.at(-1);
}

test('AC6: a private /start enqueues one ingest.start with the hash, never the code; a redelivery enqueues nothing', async () => {
  const code = 'c'.repeat(32);
  const update = {
    update_id: 880001,
    message: {
      message_id: 1,
      date: 1792200000,
      text: `/start ${code}`,
      from: { id: 9101, is_bot: false, username: 'tester_one' },
      chat: { id: 9101, type: 'private' },
    },
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request(webhookApp)
      .post(`/api/v1/webhooks/telegram/${connectionId}`)
      .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
      .send(update);

    expect(response.status).toBe(200);
  }

  const jobs = await pool.query<{ data: Record<string, string> }>(
    "SELECT data FROM pgboss.job WHERE name = 'ingest.start'",
  );

  expect(jobs.rows).toHaveLength(1);
  expect(jobs.rows[0].data).toEqual({
    workspaceId,
    connectionId,
    chatId: '9101',
    senderExternalId: '9101',
    senderHandle: 'tester_one',
    codeHash: hash(code).toString('hex'),
  });
  expect(JSON.stringify(jobs.rows[0].data)).not.toContain(code);
});

test('AC7: a valid invite links the person, consumes the invite, moves the username and replies', async () => {
  const tari = await addPerson('Tari Invite');
  const holder = await addPerson('Uli Holder', { handle: '@tari_t' });

  await addInvite(tari, 'a'.repeat(32));
  await start({ id: '9201', handle: 'tari_t' }, 'a'.repeat(32));

  expect(await identityOf(tari)).toEqual([
    { external_id: '9201', handle: '@tari_t', started: true },
  ]);
  expect(await identityOf(holder)).toEqual([]);
  expect(
    (await pool.query('SELECT consumed_at FROM person_invites WHERE person_id = $1', [tari])).rows,
  ).toEqual([{ consumed_at: now }]);
  expect(lastReply()).toEqual({ chatId: '9201', text: replies.connected });
});

test('AC8: an expired, consumed or unknown code changes nothing and replies invalid', async () => {
  const vina = await addPerson('Vina Late');
  const wawan = await addPerson('Wawan Used');

  await addInvite(vina, 'b'.repeat(32), { expiresAt: new Date(now.getTime() - 1000) });
  await addInvite(wawan, 'd'.repeat(32), { consumed: true });

  for (const code of ['b'.repeat(32), 'd'.repeat(32), 'e'.repeat(32)]) {
    await start({ id: '9301' }, code);
    expect(lastReply()).toEqual({ chatId: '9301', text: replies.invalid });
  }

  expect(await identityOf(vina)).toEqual([]);
  expect(await identityOf(wawan)).toEqual([]);
});

test('AC8: a Telegram id already linked to another active person is refused as taken', async () => {
  await addPerson('Xena Linked', { externalId: '9401' });
  const yusuf = await addPerson('Yusuf Invited');

  await addInvite(yusuf, 'f'.repeat(32));
  await start({ id: '9401' }, 'f'.repeat(32));

  expect(await identityOf(yusuf)).toEqual([]);
  expect(lastReply()).toEqual({ chatId: '9401', text: replies.taken });
});

test('AC9: /start alone restarts a linked person, and asks an unlinked one to get a link', async () => {
  const zaki = await addPerson('Zaki Back', { externalId: '9501', handle: '@zaki_b' });

  await start({ id: '9501' });
  expect(await identityOf(zaki)).toEqual([
    { external_id: '9501', handle: '@zaki_b', started: true },
  ]);
  expect(lastReply()).toEqual({ chatId: '9501', text: replies.connected });

  await start({ id: '9502' });
  expect(lastReply()).toEqual({ chatId: '9502', text: replies.askAdmin });
});

test('AC7: a refused reply is dropped; the link is kept', async () => {
  const ayu = await addPerson('Ayu Blocked');

  await addInvite(ayu, '1'.repeat(32));
  sendResult.mockResolvedValueOnce({ unreachable: true });
  await expect(start({ id: '9601' }, '1'.repeat(32))).resolves.toBeUndefined();
  expect(await identityOf(ayu)).toEqual([{ external_id: '9601', handle: null, started: true }]);
});
