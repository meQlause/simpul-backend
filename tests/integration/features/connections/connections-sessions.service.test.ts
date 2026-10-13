import { beforeEach, expect, test, vi } from 'vitest';
import request from 'supertest';
import {
  app,
  webhookApp,
  cookie,
  pool,
  provider,
  webhookSecret,
  setFixtureNow,
} from '../../../helpers/channel-activation.js';

const instant = new Date('2026-10-10T04:01:00Z');
const later = new Date('2026-10-10T04:02:00Z');
const group = -54321;
const otherGroup = -54322;
let updates = 100;

beforeEach(() => {
  vi.clearAllMocks();
  setFixtureNow(instant);
});

async function botConnectionId() {
  return (await pool.query<{ id: string }>('SELECT id FROM bot_connections')).rows[0].id;
}

async function identifySession(bot: string) {
  const issued = await request(app)
    .post('/api/v1/telegram/connections/' + bot + '/sessions')
    .set('Cookie', cookie)
    .send({ purpose: 'identify_group' });

  expect(issued.status).toBe(201);

  return issued.body.data as { id: string; command: string };
}

function deliver(bot: string, text: string, chatId = group, extras: object = {}) {
  updates += 1;

  return request(webhookApp)
    .post('/api/v1/webhooks/telegram/' + bot)
    .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
    .send({
      update_id: updates,
      message: {
        message_id: updates,
        date: instant.getTime() / 1000,
        from: { id: 123, is_bot: false, first_name: 'Tester' },
        text,
        chat: { id: chatId, type: 'supergroup', title: 'Test group' },
        ...extras,
      },
    });
}

function pollSession(sessionId: string) {
  return request(app)
    .get('/api/v1/telegram/connection-sessions/' + sessionId)
    .set('Cookie', cookie);
}

async function storedReceipt(sessionId: string) {
  return (
    await pool.query<{ received_at: Date | null }>(
      'SELECT received_at FROM channel_connection_sessions WHERE id = $1',
      [sessionId],
    )
  ).rows[0].received_at;
}

async function activitySnapshot() {
  return Promise.all(
    ['messages_raw', 'threads', 'notifications'].map(
      async (table) => (await pool.query('SELECT id FROM ' + table)).rowCount,
    ),
  );
}

test('AC1: a command in the group, then one ordinary message from it, records receivedAt on the identify session', async () => {
  const bot = await botConnectionId();
  const issued = await identifySession(bot);

  expect((await deliver(bot, issued.command)).status).toBe(200);
  expect((await deliver(bot, 'hello group')).status).toBe(200);

  expect(await storedReceipt(issued.id)).toEqual(instant);
  expect((await pollSession(issued.id)).body.data).toMatchObject({
    state: 'identified',
    receivedAt: instant.toISOString(),
  });
});

test('AC2: an ordinary message in another group records nothing', async () => {
  const bot = await botConnectionId();
  const issued = await identifySession(bot);

  await deliver(bot, issued.command);
  await deliver(bot, 'hello group', otherGroup);

  expect(await storedReceipt(issued.id)).toBeNull();
});

test('AC3: an ordinary message in the group before its command records nothing', async () => {
  const bot = await botConnectionId();
  const issued = await identifySession(bot);

  await deliver(bot, 'before the command');
  await deliver(bot, issued.command);

  expect(await storedReceipt(issued.id)).toBeNull();
});

test('AC4: a message after the session expires records nothing', async () => {
  const bot = await botConnectionId();
  const issued = await identifySession(bot);

  await deliver(bot, issued.command);
  const { rows } = await pool.query<{ expires_at: Date }>(
    'SELECT expires_at FROM channel_connection_sessions WHERE id = $1',
    [issued.id],
  );
  const afterExpiry = new Date(rows[0].expires_at.getTime() + 1000);

  setFixtureNow(afterExpiry);
  await deliver(bot, 'hello group', group, { date: afterExpiry.getTime() / 1000 });

  expect(await storedReceipt(issued.id)).toBeNull();
});

test('AC5: a help command, an edited message, a bot sender, and a message dated before the session each record nothing', async () => {
  const bot = await botConnectionId();
  const issued = await identifySession(bot);

  await deliver(bot, issued.command);
  await deliver(bot, '/help');
  expect(await storedReceipt(issued.id)).toBeNull();

  updates += 1;
  await request(webhookApp)
    .post('/api/v1/webhooks/telegram/' + bot)
    .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
    .send({
      update_id: updates,
      edited_message: {
        message_id: updates,
        date: instant.getTime() / 1000,
        from: { id: 123, is_bot: false, first_name: 'Tester' },
        text: 'hello group',
        chat: { id: group, type: 'supergroup', title: 'Test group' },
      },
    });
  expect(await storedReceipt(issued.id)).toBeNull();

  await deliver(bot, 'hello group', group, {
    from: { id: 124, is_bot: true, first_name: 'Helper' },
  });
  expect(await storedReceipt(issued.id)).toBeNull();

  await deliver(bot, 'hello group', group, { date: (instant.getTime() - 60_000) / 1000 });
  expect(await storedReceipt(issued.id)).toBeNull();
});

test('AC6: the proof message is not stored, counts no activity, monitors nothing, and sends nothing', async () => {
  const bot = await botConnectionId();
  const issued = await identifySession(bot);
  const marker = 'marker-proof-text-6f2a';

  await deliver(bot, issued.command);
  const before = await activitySnapshot();
  const monitoredBefore = (await pool.query('SELECT id FROM channels WHERE monitored')).rowCount;

  await deliver(bot, marker);

  expect(await activitySnapshot()).toEqual(before);
  expect((await pool.query('SELECT id FROM channels WHERE monitored')).rowCount).toBe(
    monitoredBefore,
  );
  expect(JSON.stringify((await pool.query('SELECT * FROM messages_raw')).rows)).not.toContain(
    marker,
  );
  expect(
    JSON.stringify(
      (await pool.query('SELECT * FROM channel_connection_sessions WHERE id = $1', [issued.id]))
        .rows,
    ),
  ).not.toContain(marker);
  expect(provider.send).not.toHaveBeenCalled();
});

test('AC7: receivedAt is null while pending and before any message, set by the first message, and a second message does not move it', async () => {
  const bot = await botConnectionId();
  const issued = await identifySession(bot);

  expect((await pollSession(issued.id)).body.data.receivedAt).toBeNull();

  await deliver(bot, issued.command);
  expect((await pollSession(issued.id)).body.data.receivedAt).toBeNull();

  await deliver(bot, 'first message');
  expect((await pollSession(issued.id)).body.data.receivedAt).toBe(instant.toISOString());

  setFixtureNow(later);
  await deliver(bot, 'second message', group, { date: later.getTime() / 1000 });
  expect((await pollSession(issued.id)).body.data.receivedAt).toBe(instant.toISOString());
});

test('AC8: a session consumed through POST /channels records nothing from a later message', async () => {
  const bot = await botConnectionId();
  const issued = await identifySession(bot);

  await deliver(bot, issued.command);
  const created = await request(app)
    .post('/api/v1/channels')
    .set('Cookie', cookie)
    .send({ botConnectionId: bot, sessionId: issued.id, displayName: 'Consumed group' });

  expect(created.status).toBe(201);

  await deliver(bot, 'hello group');

  expect(await storedReceipt(issued.id)).toBeNull();
});
