import { z as schema } from 'zod';
import { DomainError } from '../../platform/errors/domain-error.js';
import { validationError } from '../../platform/errors/validation-error.js';
import { parseChannelId } from './channels.schema.js';

export function parseChannelVerification(body: unknown, channelId: unknown) {
  const parsed = schema.strictObject({}).safeParse(body ?? {});
  if (!parsed.success) {
    throw new DomainError('E-TG-INPUT-INVALID', validationError(parsed.error).details);
  }
  return parseChannelId(channelId);
}
