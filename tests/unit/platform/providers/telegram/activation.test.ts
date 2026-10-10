import { expect, test, vi } from 'vitest';
import { createTelegramProvider } from '../../../../../src/platform/providers/index.js';

const connection = {
  credential: 'test-only-token',
  providerAccountId: '123',
  webhookUrl: 'https://simpul.example/hook',
};

function stub(memberStatus = 'member', webhookUrl = connection.webhookUrl) {
  const results: Record<string, object> = {
    getMe: {
      id: 123,
      is_bot: true,
      first_name: 'Bot',
      username: 'test_bot',
      can_join_groups: true,
      can_read_all_group_messages: true,
    },
    getChat: { id: -12345, title: 'Test group', type: 'supergroup' },
    getChatMember: { status: memberStatus },
    getWebhookInfo: { url: webhookUrl },
    sendMessage: { message_id: 456 },
  };
  const send = vi.fn<typeof fetch>(
    async (url) =>
      new Response(
        JSON.stringify({ ok: true, result: results[String(url).split('/').at(-1) ?? ''] }),
      ),
  );
  return { provider: createTelegramProvider('https://telegram.example', send), send };
}

test('Activation re-checks identity, group, membership, privacy and owned webhook without requiring administrator rights or claiming inbound proof', async () => {
  const { provider, send } = stub();
  const checks = await provider.checkReadiness(connection, '-12345');
  expect(checks.map(({ key, status }) => ({ key, status }))).toEqual(
    ['bot_identity', 'group', 'membership', 'privacy_mode', 'webhook'].map((key) => ({
      key,
      status: 'pass',
    })),
  );
  expect(send.mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual([
    'getMe',
    'getChat',
    'getChatMember',
    'getWebhookInfo',
  ]);
  expect(JSON.parse(String(send.mock.calls[2][1]?.body))).toEqual({
    chat_id: '-12345',
    user_id: 123,
  });
});

test.each(['left', 'kicked'])(
  'Activation refuses membership %s before posting an indicator',
  async (status) => {
    const { provider, send } = stub(status);
    await expect(provider.checkReadiness(connection, '-12345')).rejects.toMatchObject({
      code: 'E-TG-GROUP-UNAVAILABLE',
    });
    expect(send.mock.calls.map(([url]) => String(url))).not.toContain(
      'https://telegram.example/bottest-only-token/sendMessage',
    );
  },
);

test('Activation refuses a foreign webhook without overwriting it', async () => {
  const { provider, send } = stub('member', 'https://other.example/hook');
  await expect(provider.checkReadiness(connection, '-12345')).rejects.toMatchObject({
    code: 'E-TG-WEBHOOK-CONFLICT',
  });
  expect(send).toHaveBeenCalledTimes(4);
});

test('The indicator sender maps the confirmed Telegram message id and sends only the approved text', async () => {
  const { provider, send } = stub();
  await expect(
    provider.send(connection, {
      kind: 'indicator',
      chatId: '-12345',
      text: 'Simpul monitoring is active',
    }),
  ).resolves.toEqual({ providerMessageId: '456' });
  expect(send.mock.calls[0][0]).toBe('https://telegram.example/bottest-only-token/sendMessage');
  expect(JSON.parse(String(send.mock.calls[0][1]?.body))).toEqual({
    chat_id: '-12345',
    text: 'Simpul monitoring is active',
  });
});
