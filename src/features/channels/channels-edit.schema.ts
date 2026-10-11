import { z as schema } from 'zod';
import { DomainError } from '../../platform/errors/domain-error.js';
import { validationError } from '../../platform/errors/validation-error.js';
import { parseChannelId } from './channels.schema.js';

const editSchema = schema.strictObject({
  displayName: schema.string().trim().min(1).max(120).optional(),
  class: schema.enum(['internal', 'external']).optional(),
  primaryLanguage: schema.enum(['id', 'en', 'auto']).optional(),
  expectedConfigVersion: schema.number().int().positive(),
});

export function parseChannelEdit(input: unknown, channelId: unknown) {
  const fields = schema.record(schema.string(), schema.unknown()).safeParse(input);

  if (
    fields.success &&
    (Object.hasOwn(fields.data, 'providerChatId') || Object.hasOwn(fields.data, 'botConnectionId'))
  ) {
    throw new DomainError('E-CHANNEL-IDENTITY-FIXED');
  }

  const parsed = editSchema.safeParse(input);

  if (!parsed.success) {
    throw new DomainError('E-TG-INPUT-INVALID', validationError(parsed.error).details);
  }

  return { ...parsed.data, channelId: parseChannelId(channelId) };
}
