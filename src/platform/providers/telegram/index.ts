import { z as schema } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../../errors/domain-error.js';
import type { SetupProvider, ReceiveProvider } from '../contract.js';

const CALL_TIMEOUT_MS = 10000;
const TOKEN_INVALID = 'E-TG-TOKEN-INVALID';
const accountSchema = schema.object({
  ok: schema.literal(true),
  result: schema.object({
    id: schema.number().int().safe(),
    is_bot: schema.literal(true),
    first_name: schema.string(),
    username: schema.string(),
    can_join_groups: schema.boolean().optional(),
    can_read_all_group_messages: schema.boolean().optional(),
  }),
});

const setupUpdate = schema.object({
  message: schema.object({
    text: schema.string().regex(/^\/simpul_connect(?:@\w+)? [0-9a-f]{32}$/u),
    chat: schema.object({
      id: schema.number().int().safe().negative(),
      title: schema.string(),
      type: schema.enum(['group', 'supergroup']),
    }),
  }),
});

function createCall(baseUrl: string, send: typeof fetch) {
  return async (credential: string, method: string, body?: object) => {
    try {
      const response = await send(
        `${baseUrl.replace(/\/$/u, '')}/bot${encodeURIComponent(credential)}/${method}`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
          redirect: 'error',
          ...(body
            ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
        },
      );
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new DomainError(TOKEN_INVALID);
      }
      return data;
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError('E-TG-SETUP-TIMEOUT');
    }
  };
}

export function createTelegramProvider(
  baseUrl: string,
  send: typeof fetch = fetch,
): SetupProvider & ReceiveProvider {
  const call = createCall(baseUrl, send);
  return {
    authenticate(request, secret) {
      const supplied = request.headers['x-telegram-bot-api-secret-token'];
      return (
        typeof supplied === 'string' &&
        timingSafeEqual(
          createHash('sha256').update(supplied).digest(),
          createHash('sha256').update(secret).digest(),
        )
      );
    },
    parse(update) {
      const parsed = setupUpdate.safeParse(update);
      if (!parsed.success) {
        return { type: 'ignore' };
      }
      const { message } = parsed.data;
      return {
        type: 'setup-command',
        code: message.text.split(' ')[1],
        chatId: String(message.chat.id),
        title: message.chat.title,
        chatType: message.chat.type,
      };
    },
    async verifyCredential(credential) {
      const parsed = accountSchema.safeParse(await call(credential, 'getMe'));
      if (!parsed.success) {
        throw new DomainError(TOKEN_INVALID);
      }
      const account = parsed.data.result;
      return {
        providerAccountId: String(account.id),
        botUsername: account.username,
        botName: account.first_name,
        canJoinGroups: account.can_join_groups === true,
        privacyModeOk: account.can_read_all_group_messages === true,
      };
    },
    async registerWebhook(connection, url, secret) {
      const info = schema
        .object({ ok: schema.literal(true), result: schema.object({ url: schema.string() }) })
        .safeParse(await call(connection.credential, 'getWebhookInfo'));
      if (!info.success) {
        throw new DomainError(TOKEN_INVALID);
      }
      if (info.data.result.url !== '' && info.data.result.url !== url) {
        throw new DomainError('E-TG-WEBHOOK-CONFLICT');
      }
      const result = await call(connection.credential, 'setWebhook', {
        url,
        secret_token: secret,
        allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member'],
      });
      if (
        !schema.object({ ok: schema.literal(true), result: schema.literal(true) }).safeParse(result)
          .success
      ) {
        throw new DomainError('E-TG-SETUP-TIMEOUT');
      }
    },
  };
}
