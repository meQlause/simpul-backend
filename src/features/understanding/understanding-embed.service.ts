import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { EmbeddingPort } from '../../platform/llm/port.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { queryPayload } from './understanding.schema.js';
import { modelInput } from './understanding.triage.repository.js';
import { embeddingExists, storeEmbedding } from './understanding-search.repository.js';

type Services = {
  resolveConnection: ConnectionResolver;
  embedding: EmbeddingPort;
  embeddingModel: string;
};

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
