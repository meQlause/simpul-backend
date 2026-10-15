import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { EmbeddingPort } from '../../platform/llm/port.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { queryPayload } from './understanding.schema.js';
import { modelInput } from './understanding.triage.repository.js';
import {
  embeddingExists,
  recordSearch,
  searchState,
  searchUnits,
  storeEmbedding,
  unitTime,
} from './understanding-search.repository.js';
import { searchAllowed, searchRange } from './understanding-search.rules.js';

type Services = {
  resolveConnection: ConnectionResolver;
  embedding: EmbeddingPort;
  embeddingModel: string;
};
type Scope = { workspaceId: string; unitId: string };
type SearchServices = { resolveConnection: ConnectionResolver } & Partial<Services>;
const day = 86_400_000;

// The redacted text of an EVENT or QUERY unit is embedded once, as a document (FR-RES-06).
// Returns whether a row was stored.
export async function embedUnit(services: Services, payload: unknown) {
  const scope = queryPayload.parse(payload);
  const input = await scopedTransaction(
    services.resolveConnection,
    scope.workspaceId,
    async (tx) => ((await embeddingExists(tx, scope)) ? null : modelInput(tx, scope)),
  );

  if (!input || input.triageClass === null || input.triageClass === 'NOISE') {
    return false;
  }

  const embedding = await services.embedding.embed({
    workspaceId: scope.workspaceId,
    text: input.bodySafe,
    task: 'document',
  });

  return scopedTransaction(services.resolveConnection, scope.workspaceId, (tx) =>
    storeEmbedding(tx, scope, { embedding, model: services.embeddingModel }),
  );
}

// The UTC midnight that starts a calendar day written YYYY-MM-DD; the schema has checked the day.
const dayStart = (value: string | null | undefined) =>
  value ? Date.parse(`${value}T00:00:00Z`) : null;

export type SearchFound = {
  conversation: { messageId: string; text: string }[];
  threadIds: string[];
};

// The model's one search for a unit (FR-RES-06): similar earlier messages of its channel become context, and the
// active or tentative work they belong to becomes candidates. Null when the unit has searched already, or when no
// embedder is configured, so the caller decides as it would without search.
export async function searchContext(
  services: SearchServices,
  scope: Scope,
  request: { query: string; from?: string | null; to?: string | null },
): Promise<SearchFound | null> {
  if (!services.embedding || !services.embeddingModel) {
    return null;
  }

  const state = await scopedTransaction(services.resolveConnection, scope.workspaceId, (tx) =>
    searchState(tx, scope),
  );

  if (!searchAllowed(state)) {
    return null;
  }

  const unitAt = await scopedTransaction(services.resolveConnection, scope.workspaceId, (tx) =>
    unitTime(tx, scope),
  );
  const end = dayStart(request.to);
  const range = searchRange(unitAt.getTime(), {
    from: dayStart(request.from),
    to: end === null ? null : end + day,
  });
  const vector = await services.embedding.embed({
    workspaceId: scope.workspaceId,
    text: request.query,
    task: 'query',
  });
  const hits = await scopedTransaction(services.resolveConnection, scope.workspaceId, (tx) =>
    searchUnits(tx, scope, { vector, from: new Date(range.from), to: new Date(range.to) }),
  );

  await scopedTransaction(services.resolveConnection, scope.workspaceId, (tx) =>
    recordSearch(tx, scope, { query: request.query, hits: hits.length }),
  );

  return {
    conversation: hits.flatMap((hit) => hit.messages),
    threadIds: [...new Set(hits.flatMap((hit) => hit.threadIds))],
  };
}
