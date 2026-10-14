import { z } from 'zod';
import { validationError } from '../../platform/errors/validation-error.js';
import { decodeCursor } from './audit-read.schema.js';

const query = z.strictObject({
  outcome: z.enum(['created', 'attached', 'held', 'rejected', 'ignored', 'pending']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

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
