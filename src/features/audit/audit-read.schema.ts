import { z } from 'zod';
import { DomainError } from '../../platform/errors/domain-error.js';
import { validationError } from '../../platform/errors/validation-error.js';

const query = z.strictObject({
  kind: z.enum(['routing', 'work', 'queue', 'digest']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
const cursorSchema = z.strictObject({ at: z.iso.datetime(), id: z.guid(), filter: z.string() });

type Filter = { kind?: string; q?: string };

function filterKey(filter: Filter) {
  return JSON.stringify([filter.kind ?? null, filter.q || null]);
}

export function decodeCursor(value: string | undefined, filter: Filter) {
  if (value === undefined) {
    return undefined;
  }

  try {
    return cursorSchema
      .refine((cursor) => cursor.filter === filterKey(filter))
      .parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new DomainError('E-VALIDATION', [{ field: 'cursor', issue: 'invalid' }]);
  }
}

export function parseDecisionQuery(input: unknown) {
  const parsed = query.safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return { ...parsed.data, cursor: decodeCursor(parsed.data.cursor, parsed.data) };
}

export function encodeDecisionCursor(row: { id: string; occurredAt: Date }, filter: Filter) {
  return Buffer.from(
    JSON.stringify({ id: row.id, at: row.occurredAt.toISOString(), filter: filterKey(filter) }),
  ).toString('base64url');
}

export function parseDecisionId(input: unknown) {
  const parsed = z.guid().safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return parsed.data;
}
