import { coalesce } from '../../../../src/features/ingest/index.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { beforeAll, expect, test, vi } from 'vitest';
import request from 'supertest';
import {
  app,
  cookie,
  pool,
  telegramFetch,
  webhookApp,
  webhookSecret,
  draftWithVerification,
} from '../../../helpers/channel-activation.js';

let channelId: string;
let connectionId: string;
let workspaceId: string;
let chatId: number;

beforeAll(async () => {
  const draft = await draftWithVerification('Crash transaction group');
  const activation = await request(app)
    .post('/api/v1/channels/' + draft.channelId + '/activate')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'crash-active')
    .send({
      verificationId: draft.verificationId,
      authorizationAck: true,
      expectedConfigVersion: 1,
    });

  expect(activation.status).toBe(200);
  channelId = draft.channelId;
  const row = (
    await pool.query(
      'SELECT workspace_id, bot_connection_id, provider_chat_id FROM channels WHERE id = $1',
      [channelId],
    )
  ).rows[0];

  workspaceId = row.workspace_id;
  connectionId = row.bot_connection_id;
  chatId = Number(row.provider_chat_id);
});

const childSource = `
import postgres from 'pg';
import { receiveUpdate } from './dist/features/ingest/ingest.service.js';
import { createConnectionResolver } from './dist/platform/db/connection-resolver.js';
import { createProviderRegistry, createTelegramProvider } from './dist/platform/providers/index.js';
const pool = new postgres.Pool({connectionString: process.env.CRASH_DATABASE_URL});
const scope = JSON.parse(process.env.CRASH_SCOPE);
await receiveUpdate({
  resolveConnection: createConnectionResolver(pool),
  providers: createProviderRegistry([createTelegramProvider('https://telegram.example', fetch)]),
  now: () => new Date('2026-10-10T04:01:00Z'),
  publish: async (tx) => {
    const message = await tx.query('SELECT id FROM messages_raw WHERE channel_id = $1', [scope.channelId]);
    process.send({inserted: message.rowCount});
    await new Promise(() => {});
  },
}, scope, JSON.parse(process.env.CRASH_UPDATE));
`;

test('A message and its job commit together: killing the process between them leaves neither', async () => {
  const update = {
    update_id: 4001,
    message: {
      message_id: 4001,
      date: 1791604860,
      text: 'crash-safe update',
      from: { id: 603, is_bot: false },
      chat: { id: chatId, title: 'Crash transaction group', type: 'supergroup' },
    },
  };
  const child = fork('--input-type=module', ['--eval', childSource], {
    env: {
      ...process.env,
      CRASH_DATABASE_URL: pool.options.connectionString,
      CRASH_SCOPE: JSON.stringify({ workspaceId, connectionId, channelId, provider: 'telegram' }),
      CRASH_UPDATE: JSON.stringify(update),
    },
    silent: true,
  });

  try {
    const message = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => {
        throw new Error('Child exited before inserting the message');
      }),
    ]);

    expect(message[0]).toEqual({ inserted: 1 });
  } finally {
    const exited = once(child, 'exit');

    child.kill('SIGKILL');
    await exited;
  }

  await vi.waitFor(async () => {
    expect(
      (await pool.query('SELECT id FROM messages_raw WHERE channel_id = $1', [channelId])).rows,
    ).toHaveLength(0);
    expect(
      (
        await pool.query('SELECT update_id FROM provider_updates WHERE bot_connection_id = $1', [
          connectionId,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(
      (await pool.query("SELECT id FROM pgboss.job WHERE data->>'channelId' = $1", [channelId]))
        .rows,
    ).toHaveLength(0);
  });
  const retried = await request(webhookApp)
    .post('/api/v1/webhooks/telegram/' + connectionId)
    .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
    .send(update);

  expect(retried.status).toBe(200);
  expect(
    (await pool.query('SELECT id FROM messages_raw WHERE channel_id = $1', [channelId])).rows,
  ).toHaveLength(1);
  expect(
    (await pool.query("SELECT id FROM pgboss.job WHERE data->>'channelId' = $1", [channelId])).rows,
  ).toHaveLength(1);
});

test('body_safe has NIK, bank-account and card patterns redacted while body is unchanged', async () => {
  const body =
    'NIK 3173010101900001 rekening 1234567890 kartu 4111 1111 1111 1111. ORD-1234567890 tambah 2 dus';
  const safe = 'NIK [REDACTED] rekening [REDACTED] kartu [REDACTED]. ORD-1234567890 tambah 2 dus';
  const response = await request(webhookApp)
    .post('/api/v1/webhooks/telegram/' + connectionId)
    .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
    .send({
      update_id: 5001,
      message: {
        message_id: 5001,
        date: 1791604860,
        text: body,
        from: { id: 604, is_bot: false },
        chat: { id: chatId, title: 'Crash transaction group', type: 'supergroup' },
      },
    });

  expect(response.status).toBe(200);
  expect(
    (
      await pool.query(
        "SELECT body, body_safe FROM messages_raw WHERE channel_id = $1 AND provider_msg_id = '5001'",
        [channelId],
      )
    ).rows,
  ).toEqual([{ body, body_safe: safe }]);
  await coalesce(
    {
      resolveConnection: createConnectionResolver(pool),
      now: () => new Date('2026-10-10T04:02:00Z'),
      debounceSeconds: 12,
    },
    { workspaceId, channelId, senderExternalId: '604' },
  );
  expect(
    (await pool.query('SELECT text FROM units WHERE channel_id = $1', [channelId])).rows,
  ).toEqual([{ text: safe }]);
});

const instantOfFixture = '2026-10-10T04:01:00Z';
const telegramText = (updateId: number, text: string) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1791604860,
    text,
    from: { id: 604, is_bot: false },
    chat: { id: chatId, title: 'Crash transaction group', type: 'supergroup' },
  },
});
const postTelegram = (body: unknown) =>
  request(webhookApp)
    .post('/api/v1/webhooks/telegram/' + connectionId)
    .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
    .send(body as object);

// Three active work items of this chat for the question to choose among.
async function candidateThreads() {
  const domain = await pool.query<{ id: string }>(
    "SELECT id FROM vocab_domains WHERE workspace_id = $1 AND name = 'Order'",
    [workspaceId],
  );
  const ids: string[] = [];

  for (const displayId of ['ORD-0901', 'ORD-0902', 'ORD-0903']) {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO threads (workspace_id, display_id, status, domain_id, channel_id, summary, genesis_confidence)
       VALUES ($1, $2, 'active', $3, $4, 'Candidate ' || $2, 1) RETURNING id`,
      [workspaceId, displayId, domain.rows[0]?.id, channelId],
    );

    ids.push(row.rows[0]?.id ?? '');
  }

  return ids;
}

// A question of this chat, offered the three candidates, open for ten minutes.
async function openQuestion(threads: string[]) {
  const unit = await pool.query<{ id: string }>(
    `INSERT INTO units (workspace_id, channel_id, text, ts_first, ts_last) VALUES ($1, $2, 'question unit', $3, $3) RETURNING id`,
    [workspaceId, channelId, instantOfFixture],
  );
  const question = await pool.query<{ id: string }>(
    `INSERT INTO open_questions (workspace_id, unit_id, channel_id, thread_ids, asked_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $5::timestamptz + interval '10 minutes') RETURNING id`,
    [workspaceId, unit.rows[0]?.id, channelId, threads, instantOfFixture],
  );

  return question.rows[0]?.id ?? '';
}

test('SRS §6.7 (FR-RES-02): a reply of 2 answers the open question of this chat and stores no message; other text is stored', async () => {
  await pool.query(
    "UPDATE person_identities SET external_id = '604' WHERE workspace_id = $1 AND provider = 'telegram' AND person_id = md5('point-star-person-2')::uuid",
    [workspaceId],
  );
  const threads = await candidateThreads();
  const first = await openQuestion(threads);

  expect((await postTelegram(telegramText(6101, '2'))).status).toBe(200);
  expect(
    (await pool.query('SELECT answer FROM open_questions WHERE id = $1', [first])).rows,
  ).toEqual([{ answer: threads[1] }]);
  expect(
    (await pool.query("SELECT count(*)::int AS n FROM messages_raw WHERE provider_msg_id = '6101'"))
      .rows[0]?.n,
  ).toBe(0);

  const second = await openQuestion(threads);

  expect((await postTelegram(telegramText(6102, '2 ORD-0091'))).status).toBe(200);
  expect(
    (await pool.query('SELECT answer FROM open_questions WHERE id = $1', [second])).rows,
  ).toEqual([{ answer: null }]);
  expect(
    (await pool.query("SELECT count(*)::int AS n FROM messages_raw WHERE provider_msg_id = '6102'"))
      .rows[0]?.n,
  ).toBe(1);
});

test('SRS §6.7 (FR-UI-19): a question callback is acknowledged once, even when its answer is ignored', async () => {
  telegramFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true })));

  const response = await postTelegram({
    update_id: 6201,
    callback_query: {
      id: 'cb-6201',
      from: { id: 604, is_bot: false },
      data: 'q:00000000-0000-4000-8000-0000000000ee:5',
      message: {
        message_id: 6201,
        date: 1791604860,
        text: 'Which order did you mean?',
        chat: { id: chatId, title: 'Crash transaction group', type: 'supergroup' },
      },
    },
  });

  expect(response.status).toBe(200);
  expect(
    telegramFetch.mock.calls.filter(([url]) => String(url).includes('answerCallbackQuery')),
  ).toHaveLength(1);
});
