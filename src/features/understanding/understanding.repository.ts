import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; unitId: string };

export async function unmatchedQuery(tx: PoolClient, scope: Scope) {
  const result = await tx.query(
    "SELECT id FROM units WHERE workspace_id = $1 AND id = $2 AND triage_class = 'QUERY' FOR UPDATE",
    [scope.workspaceId, scope.unitId],
  );

  return result.rowCount === 1;
}

export async function insertOrphan(tx: PoolClient, scope: Scope, reason: string) {
  await tx.query(
    'INSERT INTO orphans (workspace_id, unit_id, reason) SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM orphans WHERE workspace_id = $1 AND unit_id = $2)',
    [scope.workspaceId, scope.unitId, reason],
  );
}
