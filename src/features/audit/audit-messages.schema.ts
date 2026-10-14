import { z } from 'zod';
import { validationError } from '../../platform/errors/validation-error.js';
import { decodeCursor } from './audit-read.schema.js';

const query = z.strictObject({
  outcome: z.enum(['created', 'attached', 'held', 'rejected', 'ignored', 'pending']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

const correction = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create'),
    categoryId: z.guid(),
    summary: z.string().trim().min(1).max(200).optional(),
  }),
  z.strictObject({
    action: z.literal('attach'),
    workDisplayId: z.string().trim().min(1).max(40),
  }),
]);

export function parseMessageQuery(input: unknown) {
  const parsed = query.safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return {
    ...parsed.data,
    cursor: decodeCursor(parsed.data.cursor, { kind: parsed.data.outcome, q: parsed.data.q }),
  };
}

export function parseUnitId(input: unknown) {
  const parsed = z.guid().safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return parsed.data;
}

export function parseCorrection(input: unknown) {
  const parsed = correction.safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return parsed.data;
}
