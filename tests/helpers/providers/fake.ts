import { createHash, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../../../src/platform/errors/domain-error.js';
import type {
  ProviderAdapter,
  OutboundMessage,
  Capabilities,
  Limits,
  SendResult,
} from '../../../src/platform/providers/index.js';

const capabilities: Capabilities = {
  replyTo: false,
  edits: false,
  deletions: false,
  inlineActions: false,
  topics: false,
  mediaGroups: false,
  voiceNotes: false,
};
const limits: Limits = { callTimeoutMs: 5000, sendPerSecond: 2, sendPerChatPerMinute: 10 };

export function createFakeProvider(
  exchange: (payload: unknown) => Promise<unknown>,
): ProviderAdapter {
  async function perform<T>(payload: unknown, result: T): Promise<T> {
    try {
      await exchange(payload);
      return result;
    } catch {
      throw new DomainError('E-INTERNAL');
    }
  }
  return {
    provider: 'fake',
    capabilities,
    limits,
    authenticate(
      request: { headers: Record<string, string | string[] | undefined> },
      secret: string,
    ) {
      const value = request.headers['x-fake-secret'];
      return (
        typeof value === 'string' &&
        timingSafeEqual(
          createHash('sha256').update(value).digest(),
          createHash('sha256').update(secret).digest(),
        )
      );
    },
    parse(_update: unknown) {
      return { type: 'ignore' as const };
    },
    verifyCredential(credential: string) {
      return perform(
        { operation: 'verify', credential },
        {
          providerAccountId: 'fake-account',
          botUsername: 'fake',
          botName: 'Fake',
          canJoinGroups: true,
          privacyModeOk: true,
        },
      );
    },
    registerWebhook(_connection: { credential: string }, url: string, secret: string) {
      return perform({ operation: 'webhook', url, secret }, undefined);
    },
    describeChat(_connection: unknown, chatId: string) {
      return perform(
        { operation: 'describe', chatId },
        { chatType: 'group' as const, title: 'Fake group' },
      );
    },
    checkReadiness(_connection: unknown, chatId: string) {
      return perform({ operation: 'readiness', chatId }, []);
    },
    send(_connection: unknown, message: OutboundMessage): Promise<SendResult> {
      return perform(
        { operation: 'send', room: message.chatId, content: message.text },
        {
          providerMessageId: 'fake-message',
        },
      );
    },
  };
}
