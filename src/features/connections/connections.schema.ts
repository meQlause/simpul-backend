import { z as schema } from 'zod';
import { DomainError } from '../../platform/errors/domain-error.js';
import { validationError } from '../../platform/errors/validation-error.js';

const INPUT_INVALID = 'E-TG-INPUT-INVALID';

const inputSchema = schema.strictObject({ botToken: schema.string().trim().min(1) });
const createSchema = inputSchema.extend({ connectionName: schema.string().trim().min(1).max(80) });
const replacementSchema = inputSchema.extend({
  expectedCredentialVersion: schema.number().int().positive(),
  connectionName: schema.string().trim().min(1).max(80).optional(),
});

export function parseReplacement(input: unknown) {
  const parsed = replacementSchema.safeParse(input);

  if (!parsed.success) {
    throw new DomainError(INPUT_INVALID, validationError(parsed.error).details);
  }

  return parsed.data;
}

export function parseConnection(input: unknown) {
  const parsed = createSchema.safeParse(input);

  if (!parsed.success) {
    throw new DomainError(INPUT_INVALID, validationError(parsed.error).details);
  }

  return parsed.data;
}

export function parseRequestKey(input: unknown) {
  const parsed = schema.string().trim().min(1).max(200).safeParse(input);

  if (!parsed.success) {
    throw new DomainError(INPUT_INVALID, [{ field: 'Idempotency-Key', issue: 'required' }]);
  }

  return parsed.data;
}

export function parseCredential(input: unknown) {
  const parsed = inputSchema.safeParse(input);

  if (!parsed.success) {
    throw new DomainError(INPUT_INVALID, validationError(parsed.error).details);
  }

  return parsed.data;
}
