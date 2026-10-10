import { afterEach, expect, test, vi } from 'vitest';
import { createProviderRegistry } from '../../../../src/platform/providers/index.js';
import { createTelegramProvider } from '../../../../src/platform/providers/telegram/index.js';
import { createFakeProvider } from '../../../helpers/providers/fake.js';

afterEach(() => vi.restoreAllMocks());

test('Architecture §9.4: configured limits are declared and the call uses the configured timeout', async () => {
  const limits = { callTimeoutMs: 5000, sendPerSecond: 15, sendPerChatPerMinute: 10 };
  const deadline = vi.spyOn(AbortSignal, 'timeout');
  const exchange = vi.fn<typeof fetch>(async () =>
    Response.json({
      ok: true,
      result: { id: 42, is_bot: true, first_name: 'Test', username: 'test_bot' },
    }),
  );
  const adapter = createTelegramProvider('https://telegram.example', exchange, limits);
  await adapter.verifyCredential('test-only-token');
  expect(adapter.limits).toEqual(limits);
  expect(deadline).toHaveBeenCalledExactlyOnceWith(limits.callTimeoutMs);
});

test('NFR-AD-02: register and adapterFor resolve the same adapter by provider name', () => {
  const registry = createProviderRegistry();
  const telegram = createTelegramProvider('https://telegram.example');
  const fake = createFakeProvider(async () => undefined);
  registry.register(telegram);
  registry.register(fake);
  expect(registry.adapterFor('telegram')).toBe(telegram);
  expect(registry.adapterFor('fake')).toBe(fake);
  expect(() => registry.assertCovers(['telegram', 'fake', 'telegram'])).not.toThrow();
  expect(() => registry.assertCovers([])).not.toThrow();
});

test('NFR-AD-02: an unregistered provider raises a named error identifying the missing registration', () => {
  const registry = createProviderRegistry();
  expect(() => registry.adapterFor('forgotten-provider')).toThrowError(
    expect.objectContaining({
      name: 'UnregisteredProviderError',
      message: expect.stringContaining('forgotten-provider'),
    }),
  );
  expect(() => registry.assertCovers(['forgotten-provider'])).toThrowError(
    expect.objectContaining({ name: 'UnregisteredProviderError' }),
  );
});

test('NFR-AD-02: registrations belong to one root container', () => {
  const registered = createProviderRegistry();
  registered.register(createFakeProvider(async () => undefined));
  expect(() => createProviderRegistry().assertCovers(['fake'])).toThrowError(
    expect.objectContaining({ name: 'UnregisteredProviderError' }),
  );
});
