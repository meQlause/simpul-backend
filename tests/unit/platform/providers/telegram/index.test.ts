import { expect, test, vi } from 'vitest';
import { createTelegramProvider } from '../../../../../src/platform/providers/index.js';

test('Credential verification calls only getMe and reads the bot identity and privacy flags', async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        ok: true,
        result: {
          id: 7214905513,
          is_bot: true,
          first_name: 'Simpul workspace bot',
          username: 'simpul_workspace_bot',
          can_join_groups: true,
          can_read_all_group_messages: true,
        },
      }),
    ),
  );
  const provider = createTelegramProvider('https://telegram.example/', send);
  await expect(provider.verifyCredential('test-only-token')).resolves.toEqual({
    providerAccountId: '7214905513',
    botUsername: 'simpul_workspace_bot',
    botName: 'Simpul workspace bot',
    canJoinGroups: true,
    privacyModeOk: true,
  });
  expect(send).toHaveBeenCalledExactlyOnceWith(
    'https://telegram.example/bottest-only-token/getMe',
    { method: 'POST', redirect: 'error', signal: expect.any(AbortSignal) },
  );
});

test.each([
  'https://other.example/hook',
  'https://simpul.example/api/v1/webhooks/telegram/another-connection',
])('SRS T-21: a foreign webhook %s is never overwritten or deleted', async (url) => {
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { url } })));
  const provider = createTelegramProvider('https://telegram.example', send);
  await expect(
    provider.registerWebhook(
      { credential: 'test-only-token' },
      'https://simpul.example/api/v1/webhooks/telegram/this-connection',
      'test-only-webhook-secret',
    ),
  ).rejects.toMatchObject({ code: 'E-TG-WEBHOOK-CONFLICT' });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toBe('https://telegram.example/bottest-only-token/getWebhookInfo');
});

test('Missing optional flags report false and a non-bot account is refused', async () => {
  const result = { id: 123, is_bot: true, first_name: 'Bot', username: 'test_bot' };
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result })))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { ...result, is_bot: false } })),
    );
  const provider = createTelegramProvider('https://telegram.example', send);
  await expect(provider.verifyCredential('test-only-token')).resolves.toMatchObject({
    canJoinGroups: false,
    privacyModeOk: false,
  });
  await expect(provider.verifyCredential('test-only-token')).rejects.toMatchObject({
    code: 'E-TG-TOKEN-INVALID',
  });
});

test.each(['', 'https://simpul.example/api/v1/webhooks/telegram/this-connection'])(
  'An empty or owned webhook %s is registered with the required update types and preserves pending updates',
  async (existingUrl) => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { url: existingUrl } })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true })));
    const provider = createTelegramProvider('https://telegram.example', send);
    const url = 'https://simpul.example/api/v1/webhooks/telegram/this-connection';
    await provider.registerWebhook(
      { credential: 'test-only-token' },
      url,
      'test-only-webhook-secret',
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBe('https://telegram.example/bottest-only-token/setWebhook');
    expect(JSON.parse(String(send.mock.calls[1][1]?.body))).toEqual({
      url,
      secret_token: 'test-only-webhook-secret',
      allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member'],
    });
  },
);
