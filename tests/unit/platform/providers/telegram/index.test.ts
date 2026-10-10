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
