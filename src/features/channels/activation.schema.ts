import { z as schema } from 'zod';
import { DomainError } from '../../platform/errors/domain-error.js';
import { validationError } from '../../platform/errors/validation-error.js';
import { parseChannelId } from './channels.schema.js';

const activationSchema = schema.strictObject({
  verificationId: schema.guid(),
  authorizationAck: schema.literal(true),
  expectedConfigVersion: schema.number().int().positive(),
});

export function parseActivation(input: unknown, channelId: unknown, key: unknown) {
  const parsed = activationSchema.safeParse(input);

  if (!parsed.success) {
    const ackOnly = parsed.error.issues.every((issue) => issue.path[0] === 'authorizationAck');

    throw new DomainError(
      ackOnly ? 'E-TG-READINESS-INCOMPLETE' : 'E-TG-INPUT-INVALID',
      validationError(parsed.error).details,
    );
  }

  const id = parseChannelId(channelId);
  const requestKey = schema.string().trim().min(1).max(200).safeParse(key);

  if (!requestKey.success) {
    throw new DomainError('E-TG-INPUT-INVALID', [{ field: 'Idempotency-Key', issue: 'required' }]);
  }

  return { ...parsed.data, channelId: id, key: requestKey.data };
}

export function parseActivationOutcome(input: unknown) {
  return schema
    .strictObject({
      channelId: schema.guid(),
      actorId: schema.guid(),
      providerMessageId: schema.string().min(1),
      chatType: schema.enum(['group', 'supergroup']),
      title: schema.string(),
      now: schema.iso.datetime().transform((value) => new Date(value)),
    })
    .parse(input);
}
