import { z } from 'zod';
import { DomainError } from '../../platform/errors/domain-error.js';
import { validationError } from '../../platform/errors/validation-error.js';

const query = z.strictObject({
  kind: z.enum(['unrouted', 'alias', 'category']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
const cursorSchema = z.strictObject({ at: z.iso.datetime(), id: z.guid(), filter: z.string() });

type Filter = { kind?: string; q?: string };

function filterKey(filter: Filter) {
  return JSON.stringify([filter.kind ?? null, filter.q || null]);
}

function decodeCursor(value: string | undefined, filter: Filter) {
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

export function parseReviewQuery(input: unknown) {
  const parsed = query.safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return { ...parsed.data, cursor: decodeCursor(parsed.data.cursor, parsed.data) };
}

export function encodeReviewCursor(row: { id: string; detectedAt: Date }, filter: Filter) {
  return Buffer.from(
    JSON.stringify({ id: row.id, at: row.detectedAt.toISOString(), filter: filterKey(filter) }),
  ).toString('base64url');
}

export function parseReviewId(input: unknown) {
  const parsed = z.guid().safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return parsed.data;
}

export function parseReviewResolution(kind: string, input: unknown) {
  const body =
    kind === 'alias'
      ? z.strictObject({ personId: z.guid() })
      : z.strictObject({ categoryId: z.guid() });
  const parsed = body.safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  if (kind === 'unrouted') {
    throw new DomainError('E-VALIDATION', [{ field: 'kind', issue: 'invalid' }]);
  }

  return parsed.data;
}

export function parseReviewBody(input: unknown) {
  const parsed = z
    .strictObject({ personId: z.guid().optional(), categoryId: z.guid().optional() })
    .refine((body) => Boolean(body.personId) !== Boolean(body.categoryId))
    .safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return parsed.data;
}
