import { z as schema } from 'zod';
import { DomainError } from '../../platform/errors/domain-error.js';
import { validationError } from '../../platform/errors/validation-error.js';

export function parseSession(input: unknown) {
  const parsed = schema
    .strictObject({ purpose: schema.enum(['identify_group', 'receive_check']) })
    .safeParse(input);

  if (!parsed.success) {
    throw new DomainError('E-TG-INPUT-INVALID', validationError(parsed.error).details);
  }

  return parsed.data;
}

export function parseSessionId(input: unknown) {
  const parsed = schema.guid().safeParse(input);

  if (!parsed.success) {
    throw new DomainError('E-NOT-FOUND');
  }

  return parsed.data;
}
