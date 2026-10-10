import { z as schema } from 'zod';
import { DomainError } from '../../platform/errors/domain-error.js';
import { validationError } from '../../platform/errors/validation-error.js';

const channelSchema = schema
  .strictObject({
    botConnectionId: schema.guid(),
    providerChatId: schema
      .string()
      .trim()
      .regex(/^-?\d+$/u)
      .optional(),
    sessionId: schema.guid().optional(),
    displayName: schema.string().trim().min(1).max(120),
    class: schema.enum(['internal', 'external']).default('external'),
    primaryLanguage: schema.enum(['id', 'en', 'auto']).default('auto'),
  })
  .refine((input) => (input.providerChatId === undefined) !== (input.sessionId === undefined), {
    path: ['providerChatId'],
  });

export function parseChannel(input: unknown) {
  const parsed = channelSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError('E-TG-INPUT-INVALID', validationError(parsed.error).details);
  }
  if (parsed.data.providerChatId === undefined) {
    return parsed.data;
  }
  const id = BigInt(parsed.data.providerChatId);
  if (id > 0n) {
    throw new DomainError('E-TG-CHAT-TYPE-UNSUPPORTED');
  }
  if (id === 0n) {
    throw new DomainError('E-TG-INPUT-INVALID', [{ field: 'providerChatId', issue: 'invalid' }]);
  }
  return { ...parsed.data, providerChatId: id.toString() };
}
