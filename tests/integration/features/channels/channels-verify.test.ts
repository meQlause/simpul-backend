import { beforeEach, expect, test, vi } from 'vitest';
import request from 'supertest';
import {
  app,
  webhookApp,
  cookie,
  pool,
  provider,
  webhookSecret,
  draftWithVerification,
  setFixtureNow,
} from '../../../helpers/channel-activation.js';
import { DomainError } from '../../../../src/platform/errors/domain-error.js';

const instant = new Date('2026-10-10T04:01:00Z');

beforeEach(() => vi.clearAllMocks());

function verify(channelId: string) {
  return request(app)
    .post('/api/v1/channels/' + channelId + '/verify')
    .set('Cookie', cookie);
}

async function receiveSession(connectionId: string) {
  const issued = await request(app)
    .post('/api/v1/telegram/connections/' + connectionId + '/sessions')
    .set('Cookie', cookie)
    .send({ purpose: 'receive_check' });

  expect(issued.status).toBe(201);

  return issued.body.data as { id: string; command: string };
}

async function identifySession(connectionId: string) {
  const issued = await request(app)
    .post('/api/v1/telegram/connections/' + connectionId + '/sessions')
    .set('Cookie', cookie)
    .send({ purpose: 'identify_group' });

  expect(issued.status).toBe(201);

  return issued.body.data as { id: string; command: string };
}

function inboundStatus(data: { checks: { key: string; status: string }[] }) {
  return data.checks.find((check) => check.key === 'inbound')?.status;
}

// Moves the clock one second past the session's expiry, then sends an ordinary message in its group.
async function deliverAfterExpiry(connectionId: string, chatId: number, sessionId: string) {
  const { rows } = await pool.query<{ expires_at: Date }>(
    'SELECT expires_at FROM channel_connection_sessions WHERE id = $1',
    [sessionId],
  );
  const afterExpiry = new Date(rows[0].expires_at.getTime() + 1000);

  setFixtureNow(afterExpiry);
  await deliver(connectionId, 'after expiry', chatId, { date: afterExpiry.getTime() / 1000 });
  setFixtureNow(instant);
}

function deliver(connectionId: string, text: string, chatId: number, extras: object = {}) {
  return request(webhookApp)
    .post('/api/v1/webhooks/telegram/' + connectionId)
    .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
    .send({
      update_id: 100,
      message: {
        message_id: 101,
        date: instant.getTime() / 1000,
        from: { id: 123, is_bot: false, first_name: 'Tester' },
        text,
        chat: { id: chatId, type: 'supergroup', title: 'Test group' },
        ...extras,
      },
    });
}

async function activitySnapshot() {
  return Promise.all(
    ['messages_raw', 'threads', 'notifications'].map(
      async (table) => (await pool.query('SELECT id FROM ' + table)).rowCount,
    ),
  );
}

async function target(scenario: string) {
  const draft = await draftWithVerification(scenario);
  const row = (
    await pool.query('SELECT provider_chat_id,bot_connection_id FROM channels WHERE id = $1', [
      draft.channelId,
    ])
  ).rows[0];

  return {
    ...draft,
    chatId: Number(row.provider_chat_id),
    connectionId: row.bot_connection_id as string,
  };
}

test('Channels API section 5: verification is bound to both versions for ten minutes and sends no notification', async () => {
  const draft = await target('Readiness without inbound');
  const response = await verify(draft.channelId);

  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    activationReady: false,
    checkedAt: instant.toISOString(),
    expiresAt: '2026-10-10T04:11:00.000Z',
  });
  expect(response.body.data.checks.map((check: { key: string }) => check.key)).toEqual([
    'bot_identity',
    'group',
    'membership',
    'privacy_mode',
    'webhook',
    'inbound',
    'indicator',
  ]);
  expect(
    response.body.data.checks.slice(-2).map((check: { status: string }) => check.status),
  ).toEqual(['pending', 'pending']);
  const stored = (
    await pool.query(
      'SELECT config_version,credential_version,status FROM channel_verifications WHERE id = $1',
      [response.body.data.id],
    )
  ).rows[0];

  expect(stored).toEqual({ config_version: 1, credential_version: 1, status: 'pending' });
  expect(provider.send).not.toHaveBeenCalled();
});

test('Channels API section 5: a command alone is not inbound proof; a fresh ordinary message in the identified group is', async () => {
  const draft = await target('Actual ordinary inbound');
  const beforeActivity = await activitySnapshot();
  const session = await receiveSession(draft.connectionId);

  expect((await deliver(draft.connectionId, session.command, draft.chatId)).status).toBe(200);
  expect((await verify(draft.channelId)).body.data.activationReady).toBe(false);
  await deliverNonProof(draft);
  expect((await verify(draft.channelId)).body.data.activationReady).toBe(false);
  expect(
    (await deliver(draft.connectionId, 'setup-private-text-marker', draft.chatId)).status,
  ).toBe(200);
  const verified = await verify(draft.channelId);

  expect(verified.status).toBe(200);
  expect(verified.body.data.activationReady).toBe(true);
  expect(
    verified.body.data.checks.slice(-2).map((check: { status: string }) => check.status),
  ).toEqual(['pass', 'pending']);
  await assertSetupOnly(draft, verified.body.data, beforeActivity, session.id);
});

test('Channels API section 5: provider failure stays a failed check with no active state', async () => {
  const draft = await target('Privacy needs action');

  provider.checkReadiness.mockResolvedValueOnce(
    ['bot_identity', 'group', 'membership', 'privacy_mode', 'webhook'].map((key) => ({
      key,
      status: key === 'privacy_mode' ? 'fail' : 'pass',
      message: 'Provider check',
      action: null,
    })),
  );
  const response = await verify(draft.channelId);

  expect(response.status).toBe(200);
  expect(response.body.data.activationReady).toBe(false);
  expect(
    response.body.data.checks.find((check: { key: string }) => check.key === 'privacy_mode').status,
  ).toBe('fail');
  expect(
    (await pool.query('SELECT monitored FROM channels WHERE id = $1', [draft.channelId])).rows[0]
      .monitored,
  ).toBe(false);
  expect(provider.send).not.toHaveBeenCalled();
});

test.each([
  ['E-TG-SETUP-TIMEOUT', 504],
  ['E-TG-RATE-LIMITED', 429],
  ['E-TG-WEBHOOK-CONFLICT', 409],
] as const)(
  'Channels API section 5: %s returns the mapped provider failure without a verification',
  async (code, status) => {
    const draft = await target(code);
    const before = (
      await pool.query('SELECT * FROM channel_verifications WHERE channel_id = $1', [
        draft.channelId,
      ])
    ).rows;

    provider.checkReadiness.mockRejectedValueOnce(
      new DomainError(code, undefined, code === 'E-TG-RATE-LIMITED' ? 30 : undefined),
    );
    const response = await verify(draft.channelId);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
    expect(
      (
        await pool.query('SELECT * FROM channel_verifications WHERE channel_id = $1', [
          draft.channelId,
        ])
      ).rows,
    ).toEqual(before);
    expect(provider.checkReadiness).toHaveBeenCalledTimes(1);
    expect(provider.send).not.toHaveBeenCalled();
  },
);

async function assertSetupOnly(
  draft: Awaited<ReturnType<typeof target>>,
  verification: unknown,
  beforeActivity: Awaited<ReturnType<typeof activitySnapshot>>,
  sessionId: string,
) {
  const detail = await request(app)
    .get('/api/v1/channels/' + draft.channelId)
    .set('Cookie', cookie);

  expect(detail.body.data.verification).toEqual(verification);
  expect(detail.body.data.monitored).toBe(false);
  expect(provider.send).not.toHaveBeenCalled();
  expect(await activitySnapshot()).toEqual(beforeActivity);
  expect(
    JSON.stringify(
      (await pool.query('SELECT * FROM channel_connection_sessions WHERE id = $1', [sessionId]))
        .rows,
    ),
  ).not.toContain('setup-private-text-marker');
}

async function deliverNonProof(draft: Awaited<ReturnType<typeof target>>) {
  await deliver(draft.connectionId, 'setup-private-text-marker', draft.chatId - 1);
  await deliver(draft.connectionId, '/help', draft.chatId);
  await deliver(draft.connectionId, 'bot message', draft.chatId, {
    from: { id: 999, is_bot: true, first_name: 'Bot' },
  });
  await deliver(draft.connectionId, 'old message', draft.chatId, {
    date: instant.getTime() / 1000 - 60,
  });
}

test('Channels API section 5: an expired receive-check session cannot prove ordinary inbound', async () => {
  const draft = await target('Expired inbound proof');
  const session = await receiveSession(draft.connectionId);

  await deliver(draft.connectionId, session.command, draft.chatId);
  await pool.query(
    `UPDATE channel_connection_sessions SET created_at = $2::timestamptz - interval '15 minutes',expires_at = $2::timestamptz - interval '1 second' WHERE id = $1`,
    [session.id, instant],
  );
  await deliver(draft.connectionId, 'ordinary after expiry', draft.chatId);
  expect((await verify(draft.channelId)).body.data.activationReady).toBe(false);
  expect(provider.send).not.toHaveBeenCalled();
});

test('Channels API section 5: rotating credentials requires a new inbound proof', async () => {
  const draft = await target('Rotated inbound proof');
  const session = await receiveSession(draft.connectionId);

  await deliver(draft.connectionId, session.command, draft.chatId);
  await deliver(draft.connectionId, 'ordinary before rotation', draft.chatId);
  expect((await verify(draft.channelId)).body.data.activationReady).toBe(true);
  const rotated = await request(app)
    .put('/api/v1/telegram/connections/' + draft.connectionId + '/credentials')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'rotate-inbound-proof')
    .send({ botToken: 'test-only-new-token', expectedCredentialVersion: 1 });

  expect(rotated.status).toBe(200);
  expect((await verify(draft.channelId)).body.data.activationReady).toBe(false);
  const fresh = await receiveSession(draft.connectionId);

  await deliver(draft.connectionId, fresh.command, draft.chatId);
  await deliver(draft.connectionId, 'ordinary after rotation', draft.chatId);
  expect((await verify(draft.channelId)).body.data.activationReady).toBe(true);
  expect(provider.send).not.toHaveBeenCalled();
});

test('Channels API section 5 (identify): a command and a fresh ordinary message in the draft group prove inbound', async () => {
  const draft = await target('Identify proof inbound');
  const session = await identifySession(draft.connectionId);

  expect((await deliver(draft.connectionId, session.command, draft.chatId)).status).toBe(200);
  expect((await deliver(draft.connectionId, 'identify proof message', draft.chatId)).status).toBe(
    200,
  );

  const verified = await verify(draft.channelId);

  expect(verified.status).toBe(200);
  expect(verified.body.data.activationReady).toBe(true);
  expect(inboundStatus(verified.body.data)).toBe('pass');
});

test('Channels API section 5 (identify): a proof in another group, before the command, or after expiry does not prove inbound', async () => {
  const draft = await target('Identify proof rejected');
  const otherChat = draft.chatId - 1;
  const elsewhere = await identifySession(draft.connectionId);

  await deliver(draft.connectionId, elsewhere.command, otherChat);
  await deliver(draft.connectionId, 'ordinary in the draft group', draft.chatId);
  await deliver(draft.connectionId, 'ordinary in the identified group', otherChat);
  expect(inboundStatus((await verify(draft.channelId)).body.data)).toBe('pending');

  const early = await identifySession(draft.connectionId);

  await deliver(draft.connectionId, 'before the command', draft.chatId);
  await deliver(draft.connectionId, early.command, draft.chatId);
  expect(inboundStatus((await verify(draft.channelId)).body.data)).toBe('pending');

  const late = await identifySession(draft.connectionId);

  await deliver(draft.connectionId, late.command, draft.chatId);
  await deliverAfterExpiry(draft.connectionId, draft.chatId, late.id);
  expect(inboundStatus((await verify(draft.channelId)).body.data)).toBe('pending');
});

test('Channels API section 5 (identify): a proof received before the draft row exists counts once the draft is saved', async () => {
  const bot = (await pool.query<{ id: string }>('SELECT id FROM bot_connections')).rows[0].id;
  const chat = '-5439901';
  const session = await identifySession(bot);

  await deliver(bot, session.command, Number(chat));
  await deliver(bot, 'ordinary before the draft', Number(chat));

  const saved = await request(app)
    .post('/api/v1/channels')
    .set('Cookie', cookie)
    .send({ botConnectionId: bot, providerChatId: chat, displayName: 'Saved after proof' });

  expect(saved.status).toBe(201);

  const verified = await verify(saved.body.data.id);

  expect(inboundStatus(verified.body.data)).toBe('pass');
});

test('Channels API section 5 (identify): rotating the credential after the proof makes inbound pending again', async () => {
  const draft = await target('Identify proof rotated');
  const session = await identifySession(draft.connectionId);

  await deliver(draft.connectionId, session.command, draft.chatId);
  await deliver(draft.connectionId, 'ordinary before rotation', draft.chatId);
  expect(inboundStatus((await verify(draft.channelId)).body.data)).toBe('pass');

  const version = (
    await pool.query<{ credential_version: number }>(
      'SELECT credential_version FROM bot_connections WHERE id = $1',
      [draft.connectionId],
    )
  ).rows[0].credential_version;
  const rotated = await request(app)
    .put('/api/v1/telegram/connections/' + draft.connectionId + '/credentials')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'rotate-identify-proof')
    .send({ botToken: 'test-only-identify-rotated', expectedCredentialVersion: version });

  expect(rotated.status).toBe(200);
  expect(inboundStatus((await verify(draft.channelId)).body.data)).toBe('pending');
});
