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
