import { afterEach, expect, test, vi } from 'vitest';
import { createTelegramProvider } from '../../../../../src/platform/providers/index.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('SRS §5.5.4: the call deadline is ten seconds and an aborted call is not retried', async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController();

    setTimeout(
      () => controller.abort(new DOMException('Provider deadline', 'TimeoutError')),
      milliseconds,
    );

    return controller.signal;
  });
  const send = vi.fn<typeof fetch>(
    async (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
      }),
  );
  const provider = createTelegramProvider('https://telegram.example', send);
  const checked = expect(provider.verifyCredential('test-only-token')).rejects.toMatchObject({
    code: 'E-TG-SETUP-TIMEOUT',
  });

  await vi.advanceTimersByTimeAsync(10000);
  await checked;
  expect(timeout).toHaveBeenCalledWith(10000);
  expect(send).toHaveBeenCalledTimes(1);
});

test('The adapter returns a neutral retry instruction for a rate-limited indicator without retrying', async () => {
  const send = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 12 } }),
        { status: 429 },
      ),
  );
  const provider = createTelegramProvider('https://telegram.example', send);

  await expect(
    provider.send(
      {
        credential: 'test-only-token',
        providerAccountId: '123',
        webhookUrl: 'https://simpul.example/hook',
      },
      { kind: 'indicator', chatId: '-12345', text: 'Simpul monitoring is active' },
    ),
  ).resolves.toEqual({ retryAfter: 12 });
  expect(send).toHaveBeenCalledTimes(1);
});

const ref = {
  credential: 'test-only-token',
  providerAccountId: '123',
  webhookUrl: 'https://simpul.example/hook',
};

function refused(status: number, description: string) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ ok: false, error_code: status, description }), { status }),
  );
}

test('A rejected token (401) is E-TG-TOKEN-INVALID', async () => {
  const provider = createTelegramProvider('https://telegram.example', refused(401, 'Unauthorized'));

  await expect(provider.verifyCredential('test-only-token')).rejects.toMatchObject({
    code: 'E-TG-TOKEN-INVALID',
  });
});

test('A group the bot cannot see (400) is E-TG-GROUP-UNAVAILABLE, not a token error', async () => {
  const provider = createTelegramProvider(
    'https://telegram.example',
    refused(400, 'Bad Request: chat not found'),
  );

  await expect(provider.describeChat(ref, '-12345')).rejects.toMatchObject({
    code: 'E-TG-GROUP-UNAVAILABLE',
  });
});

test('A person who never started the bot (400/403) is not reported as a token error', async () => {
  const provider = createTelegramProvider(
    'https://telegram.example',
    refused(403, 'Forbidden: bot can not initiate conversation with a user'),
  );

  await expect(
    provider.send(ref, { kind: 'notification', chatId: '1234567890', text: 'PAY-0003' }),
  ).rejects.not.toMatchObject({ code: 'E-TG-TOKEN-INVALID' });
});
