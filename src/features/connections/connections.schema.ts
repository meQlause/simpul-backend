import { z as schema } from 'zod';
import { DomainError } from '../../platform/errors/domain-error.js';
import { validationError } from '../../platform/errors/validation-error.js';

const inputSchema = schema.strictObject({ botToken: schema.string().trim().min(1) });
export function parseCredential(input: unknown) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError('E-TG-INPUT-INVALID', validationError(parsed.error).details);
  }
  return parsed.data;
}
