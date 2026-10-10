import { expect, test, vi } from 'vitest';
import { createTelegramProvider } from '../../../../../src/platform/providers/index.js';

test.each([
  [{ retry_after: 0 }, undefined, 0],
  [undefined, '13', 13],
  [{ retry_after: -1 }, undefined, 60],
  [undefined, undefined, 60],
] as const)(
  'A rate limit forwards valid wait metadata and otherwise advises one minute without automatic retry (%j, %s)',
  async (parameters, header, seconds) => {
    const send = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ok: false, error_code: 429, parameters }), {
          status: 429,
          headers: header === undefined ? {} : { 'Retry-After': header },
        }),
    );
    const provider = createTelegramProvider('https://telegram.example', send);
    await expect(provider.verifyCredential('test-only-token')).rejects.toMatchObject({
      status: 429,
      code: 'E-TG-RATE-LIMITED',
      retryAfter: seconds,
    });
    expect(send).toHaveBeenCalledTimes(1);
  },
);
