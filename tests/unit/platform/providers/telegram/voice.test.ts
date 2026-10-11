import { expect, test, vi } from 'vitest';
import { createTelegramProvider } from '../../../../../src/platform/providers/index.js';

test('SRS §12.4: a Telegram voice note becomes a neutral media message without invented text', () => {
  const provider = createTelegramProvider('https://api.telegram.org');

  expect(
    provider.parse({
      update_id: 42,
      message: {
        message_id: 43,
        date: 1791604800,
        from: { id: 605, is_bot: false },
        chat: { id: -100240000001, title: 'Warehouse', type: 'supergroup' },
        voice: { file_id: 'voice-file', mime_type: 'audio/ogg', duration: 3 },
      },
    }),
  ).toMatchObject({
    type: 'message',
    body: '',
    mediaRef: JSON.stringify({ fileId: 'voice-file', mimeType: 'audio/ogg' }),
  });
});

test('SRS §12.4: the Telegram adapter downloads voice bytes using getFile rather than a payload URL', async () => {
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, result: { file_path: 'voice/file.ogg', file_size: 2 } }),
      ),
    )
    .mockResolvedValueOnce(new Response(new Uint8Array([1, 2])));
  const provider = createTelegramProvider('https://api.telegram.org', send);
  const audio = await provider.downloadVoice?.(
    { credential: 'test-token', providerAccountId: '123', webhookUrl: 'https://simpul.example' },
    JSON.stringify({ fileId: 'voice-file', mimeType: 'audio/ogg' }),
  );

  expect(audio).toEqual({ data: new Uint8Array([1, 2]), mimeType: 'audio/ogg' });
  expect(send.mock.calls[1][0]).toBe('https://api.telegram.org/file/bottest-token/voice/file.ogg');
  expect(send.mock.calls[1][1]).toMatchObject({
    redirect: 'error',
    signal: expect.any(AbortSignal),
  });
});

test('Telegram voice download rejects a traversal path without requesting it', async () => {
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, result: { file_path: '../secret.ogg', file_size: 2 } }),
      ),
    );
  const provider = createTelegramProvider('https://api.telegram.org', send);

  await expect(
    provider.downloadVoice?.(
      { credential: 'test-token', providerAccountId: '123', webhookUrl: 'https://simpul.example' },
      JSON.stringify({ fileId: 'voice-file', mimeType: 'audio/ogg' }),
    ),
  ).rejects.toMatchObject({ code: 'E-INTERNAL' });
  expect(send).toHaveBeenCalledTimes(1);
});
