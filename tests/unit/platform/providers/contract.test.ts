import { describe, expect, test, vi } from 'vitest';
import { createTelegramProvider } from '../../../../src/platform/providers/telegram/index.js';
import { DomainError } from '../../../../src/platform/errors/domain-error.js';
import { createFakeProvider } from '../../../helpers/providers/fake.js';

const connection = {
  credential: 'test-only-token',
  providerAccountId: '42',
  webhookUrl: 'https://simpul.example/hook',
};
const kinds = ['notification', 'question', 'correction', 'indicator', 'notice'] as const;

function telegram() {
  const exchange = vi.fn<typeof fetch>(async () =>
    Response.json({ ok: true, result: { message_id: 7 } }),
  );
  return {
    adapter: createTelegramProvider('https://telegram.example', exchange),
    exchange,
    secretHeader: 'x-telegram-bot-api-secret-token',
    outbound: () => JSON.parse(String(exchange.mock.calls[0][1]?.body)),
    expectedOutbound: {
      chat_id: '-10',
      text: 'Rendered message',
      reply_markup: { inline_keyboard: [[{ text: 'Accept', callback_data: 'accept' }]] },
      reply_parameters: { message_id: 3 },
    },
    fail(mode: string) {
      if (mode === 'transport') {
        exchange.mockRejectedValue(new Error('raw provider text containing test-only-token'));
        return;
      }
      exchange.mockImplementation(async () =>
        mode === 'malformed'
          ? new Response('test-only-token')
          : Response.json({ ok: false, description: 'test-only-token' }, { status: Number(mode) }),
      );
    },
  };
}

function fake() {
  const exchange = vi.fn(async (_payload: unknown) => undefined);
  return {
    adapter: createFakeProvider(exchange),
    exchange,
    secretHeader: 'x-fake-secret',
    outbound: () => exchange.mock.calls[0][0],
    expectedOutbound: { operation: 'send', room: '-10', content: 'Rendered message' },
    fail(mode: string) {
      exchange.mockRejectedValue(
        new Error(`${mode}: raw provider text containing test-only-token`),
      );
    },
  };
}

type CreateHarness = typeof telegram | typeof fake;

function receiveCases(name: string, create: CreateHarness) {
  test('one adapter declares its provider, capabilities and limits', () => {
    const { adapter } = create();
    expect(adapter).toHaveProperty('provider', name);
    for (const capability of [
      'replyTo',
      'edits',
      'deletions',
      'inlineActions',
      'topics',
      'mediaGroups',
      'voiceNotes',
    ]) {
      expect(adapter).toHaveProperty(`capabilities.${capability}`, expect.any(Boolean));
    }
    expect(adapter).toHaveProperty('limits.callTimeoutMs', expect.any(Number));
    expect(adapter).toHaveProperty('limits.sendPerSecond', expect.any(Number));
    expect(adapter).toHaveProperty('limits.sendPerChatPerMinute', expect.any(Number));
  });

  test('authenticate rejects a wrong or absent secret and accepts the correct secret', () => {
    const { adapter, secretHeader } = create();
    expect(
      adapter.authenticate({ headers: { [secretHeader]: 'wrong-secret' } }, 'right-secret'),
    ).toBe(false);
    expect(adapter.authenticate({ headers: {} }, 'right-secret')).toBe(false);
    expect(
      adapter.authenticate({ headers: { [secretHeader]: ['right-secret'] } }, 'right-secret'),
    ).toBe(false);
    expect(
      adapter.authenticate({ headers: { [secretHeader]: 'right-secret' } }, 'right-secret'),
    ).toBe(true);
  });

  test.each([
    null,
    undefined,
    'unknown',
    [],
    { update_id: 5, future_event: {} },
    { message: { text: 123 } },
  ])('an unknown update parses as ignore without throwing: %j', (update) => {
    expect(create().adapter.parse(update)).toEqual({ type: 'ignore' });
  });
}

function sendCases(name: string, create: CreateHarness) {
  test.each(kinds)('every OutboundMessage kind sends through the adapter: %s', async (kind) => {
    const { adapter, exchange } = create();
    expect(
      await adapter.send(connection, { kind, chatId: '-10', text: 'Rendered message' }),
    ).toEqual({ providerMessageId: name === 'telegram' ? '7' : 'fake-message' });
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  test('declared inlineActions and replyTo capabilities match the outbound request', async () => {
    const { adapter, outbound, expectedOutbound } = create();
    await adapter.send(connection, {
      kind: 'question',
      chatId: '-10',
      text: 'Rendered message',
      actions: [{ id: 'accept', label: 'Accept' }],
      replyToMessageId: '3',
    });
    expect(outbound()).toEqual(expectedOutbound);
  });
}

function failureCases(create: CreateHarness) {
  describe.each(['transport', 'malformed', '200', '401', '403', '500'])(
    'provider failure %s',
    (mode) => {
      test.each(['verify', 'webhook', 'describe', 'readiness', 'send'] as const)(
        'every provider failure maps to a Simpul code before returning: %s',
        async (operation) => {
          const { adapter, exchange, fail } = create();
          fail(mode);
          const calls = {
            verify: () => adapter.verifyCredential(connection.credential),
            webhook: () =>
              adapter.registerWebhook(connection, connection.webhookUrl, 'test-only-secret'),
            describe: () => adapter.describeChat(connection, '-10'),
            readiness: () => adapter.checkReadiness(connection, '-10'),
            send: () =>
              adapter.send(connection, { kind: 'notice', chatId: '-10', text: 'Rendered' }),
          };
          const failure = calls[operation]();
          await expect(failure).rejects.toBeInstanceOf(DomainError);
          await expect(failure).rejects.toMatchObject({
            code: expect.stringMatching(/^E-/u),
          });
          await expect(failure).rejects.not.toHaveProperty(
            'message',
            expect.stringContaining(connection.credential),
          );
          expect(exchange).toHaveBeenCalledTimes(1);
        },
      );
    },
  );
}

describe.each([
  ['telegram', telegram],
  ['fake', fake],
] as const)('NFR-AD-01 / NFR-AD-04: %s adapter contract', (name, create) => {
  receiveCases(name, create);
  sendCases(name, create);
  failureCases(create);
});
