import { z as schema } from 'zod';
import { DomainError } from '../../errors/domain-error.js';
import type { CredentialProvider } from '../contract.js';

const CALL_TIMEOUT_MS = 10000;
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

export function createTelegramProvider(
  baseUrl: string,
  send: typeof fetch = fetch,
): CredentialProvider {
  return {
    async verifyCredential(credential) {
      let response: Response;
      try {
        response = await send(
          `${baseUrl.replace(/\/$/u, '')}/bot${encodeURIComponent(credential)}/getMe`,
          {
            method: 'POST',
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
            redirect: 'error',
          },
        );
      } catch {
        throw new DomainError('E-TG-SETUP-TIMEOUT');
      }
      const parsed = accountSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success) {
        throw new DomainError('E-TG-TOKEN-INVALID');
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
  };
}
