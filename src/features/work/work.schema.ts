import { z as schema } from 'zod';
import { DomainError } from '../../platform/errors/domain-error.js';
import { validationError } from '../../platform/errors/validation-error.js';

const querySchema = schema.strictObject({
  status: schema
    .enum(['tentative', 'active', 'stalled', 'completed', 'cancelled', 'archived'])
    .optional(),
  q: schema.string().trim().max(100).optional(),
  limit: schema.coerce.number().int().min(1).max(100).default(25),
  cursor: schema.string().optional(),
});
const cursorSchema = schema.strictObject({
  at: schema.iso.datetime(),
  id: schema.guid(),
  filter: schema.string(),
});

type Filter = { status?: string; q?: string };

function filterKey(filter: Filter) {
  return JSON.stringify([filter.status ?? null, filter.q || null]);
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

export function parseWorkQuery(input: unknown) {
  const parsed = querySchema.safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return { ...parsed.data, cursor: decodeCursor(parsed.data.cursor, parsed.data) };
}

export function encodeWorkCursor(row: { id: string; lastActivityAt: Date }, filter: Filter) {
  return Buffer.from(
    JSON.stringify({ at: row.lastActivityAt.toISOString(), id: row.id, filter: filterKey(filter) }),
  ).toString('base64url');
}

const genesisSchema = schema.strictObject({
  domainId: schema.guid(),
  channelId: schema.guid(),
  summary: schema.string().trim().min(1),
  confidence: schema.number().min(0).max(1),
});

export function parseGenesis(input: unknown) {
  const parsed = genesisSchema.safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return parsed.data;
}

export function parseClosure(input: unknown) {
  const parsed = schema
    .strictObject({
      closure: schema.enum(['completed', 'cancelled', 'outside_chat']),
      reason: schema.string().trim().min(5).max(300),
    })
    .safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return parsed.data;
}
