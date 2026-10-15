import type { PoolClient } from 'pg';
import { SEARCH_LIMIT, SEARCH_MIN_SIMILARITY } from './understanding-search.rules.js';

type Scope = { workspaceId: string; unitId: string };

export type SearchHit = {
  unitId: string;
  at: Date;
  similarity: number;
  messages: { messageId: string; text: string }[];
  threadIds: string[];
};

export async function embeddingExists(tx: PoolClient, scope: Scope) {
  const { rowCount } = await tx.query(
    'SELECT 1 FROM unit_embeddings WHERE workspace_id = $1 AND unit_id = $2',
    [scope.workspaceId, scope.unitId],
  );

  return rowCount === 1;
}

// A row is written once; a second embedding of the same unit does nothing (FR-RES-06).
export async function storeEmbedding(
  tx: PoolClient,
  scope: Scope,
  stored: { embedding: number[]; model: string },
) {
  const { rowCount } = await tx.query(
    `INSERT INTO unit_embeddings (workspace_id, unit_id, embedding, model) VALUES ($1, $2, $3::vector, $4)
     ON CONFLICT (unit_id) DO NOTHING`,
    [scope.workspaceId, scope.unitId, JSON.stringify(stored.embedding), stored.model],
  );

  return rowCount === 1;
}

// Every EVENT or QUERY unit of the workspace that has no embedding yet, oldest first.
export async function unitsToEmbed(tx: PoolClient, workspaceId: string) {
  const { rows } = await tx.query<{ unitId: string }>(
    `SELECT u.id AS "unitId" FROM units u
     WHERE u.workspace_id = $1 AND u.triage_class IN ('EVENT', 'QUERY')
       AND NOT EXISTS (SELECT 1 FROM unit_embeddings e WHERE e.unit_id = u.id)
     ORDER BY u.ts_first, u.id`,
    [workspaceId],
  );

  return rows.map((row) => row.unitId);
}

// The query already run for the unit, or null: a unit is searched once (AC8).
export async function searchState(tx: PoolClient, scope: Scope) {
  const { rows } = await tx.query<{ searchQuery: string | null }>(
    'SELECT search_query AS "searchQuery" FROM unit_resolutions WHERE workspace_id = $1 AND unit_id = $2',
    [scope.workspaceId, scope.unitId],
  );

  return rows[0] ?? { searchQuery: null };
}

export async function unitTime(tx: PoolClient, scope: Scope) {
  const { rows } = await tx.query<{ at: Date }>(
    'SELECT ts_first AS at FROM units WHERE workspace_id = $1 AND id = $2',
    [scope.workspaceId, scope.unitId],
  );

  return rows[0].at;
}

// The most similar units of the unit's own channel within the range (FR-RES-06). The unit itself, noise and
// another channel never qualify; each hit carries its messages and the active or tentative work they belong to.
export async function searchUnits(
  tx: PoolClient,
  scope: Scope,
  input: { vector: number[]; from: Date; to: Date },
) {
  const vector = JSON.stringify(input.vector);
  const { rows } = await tx.query<SearchHit>(
    `WITH hits AS (
      SELECT u.id, u.ts_last AS at, 1 - (e.embedding <=> $3::vector) AS similarity
      FROM unit_embeddings e JOIN units u ON u.id = e.unit_id AND u.workspace_id = e.workspace_id
      WHERE e.workspace_id = $1 AND u.channel_id = (SELECT channel_id FROM units WHERE workspace_id = $1 AND id = $2)
        AND u.id <> $2 AND u.triage_class <> 'NOISE' AND u.ts_last >= $4 AND u.ts_last < $5
        AND 1 - (e.embedding <=> $3::vector) >= $6
      ORDER BY e.embedding <=> $3::vector
      LIMIT $7
    )
    SELECT h.id AS "unitId", h.at, h.similarity,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('messageId', m.id, 'text', m.body_safe) ORDER BY m.server_ts, m.id), '[]'::jsonb)
        FROM unit_messages um JOIN messages_raw m ON m.id = um.message_id AND m.workspace_id = $1
        WHERE um.workspace_id = $1 AND um.unit_id = h.id) AS messages,
      ARRAY(SELECT DISTINCT t.id FROM unit_messages um
        JOIN message_thread_link l ON l.message_id = um.message_id AND l.workspace_id = $1
        JOIN threads t ON t.id = l.thread_id AND t.workspace_id = $1
        WHERE um.workspace_id = $1 AND um.unit_id = h.id AND t.status IN ('active', 'tentative')) AS "threadIds"
    FROM hits h ORDER BY h.similarity DESC`,
    [
      scope.workspaceId,
      scope.unitId,
      vector,
      input.from,
      input.to,
      SEARCH_MIN_SIMILARITY,
      SEARCH_LIMIT,
    ],
  );

  return rows;
}

// Stores the query and how many units it returned; the unit cannot be searched again.
export async function recordSearch(
  tx: PoolClient,
  scope: Scope,
  search: { query: string; hits: number },
) {
  await tx.query(
    'UPDATE unit_resolutions SET search_query = $3, search_hits = $4 WHERE workspace_id = $1 AND unit_id = $2',
    [scope.workspaceId, scope.unitId, search.query, search.hits],
  );
}
