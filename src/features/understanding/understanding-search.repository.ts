import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; unitId: string };

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
