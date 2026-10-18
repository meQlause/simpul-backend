import type { Pool } from 'pg';
import type { readConfig } from '../platform/config/index.js';
import type { EmbeddingPort } from '../platform/llm/port.js';
import type { ConnectionResolver } from '../platform/db/connection-resolver.js';
import { createSystemPool } from '../platform/db/index.js';
import { createConnectionResolver } from '../platform/db/connection-resolver.js';
import { scopedTransaction } from '../platform/db/scoped-transaction.js';
import { createGeminiEmbedding } from '../platform/llm/gemini-embedding.js';
import { createLogger } from '../platform/logger/index.js';
import { embedUnit } from '../features/understanding/understanding-embed.service.js';
import { unitsToEmbed } from '../features/understanding/understanding-search.repository.js';

type Services = {
  pool: Pool;
  resolveConnection: ConnectionResolver;
  embedding: EmbeddingPort;
  embeddingModel: string;
};

async function backfillWorkspace(services: Services, workspaceId: string) {
  const unitIds = await scopedTransaction(services.resolveConnection, workspaceId, (tx) =>
    unitsToEmbed(tx, workspaceId),
  );
  let stored = 0;

  for (const unitId of unitIds) {
    if (await embedUnit(services, { workspaceId, unitId })) {
      stored += 1;
    }
  }

  return stored;
}

// Embeds every EVENT or QUERY unit that has no embedding yet, workspace by workspace.
// Returns how many rows it stored; a second run finds none.
export async function backfillEmbeddings(services: Services) {
  const { rows } = await services.pool.query<{ id: string }>(
    'SELECT id FROM workspaces ORDER BY id',
  );
  let stored = 0;

  for (const { id } of rows) {
    stored += await backfillWorkspace(services, id);
  }

  return stored;
}

// The `backfill-embeddings` command: the count is logged on stdout.
export async function runBackfillEmbeddings(config: ReturnType<typeof readConfig>) {
  const pool = createSystemPool(config.DATABASE_URL);
  const logger = createLogger(config.LOG_LEVEL);

  try {
    const stored = await backfillEmbeddings({
      pool,
      resolveConnection: createConnectionResolver(pool),
      embedding: createGeminiEmbedding({
        vertex: {
          project: config.GOOGLE_CLOUD_PROJECT,
          location: config.VERTEX_EMBEDDING_LOCATION,
        },
        model: config.GEMINI_MODEL_EMBEDDING,
      }),
      embeddingModel: config.GEMINI_MODEL_EMBEDDING,
    });

    logger.info({ stored }, 'Embeddings backfilled');
  } finally {
    await pool.end();
  }
}
