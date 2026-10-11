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

export async function lockUnlabelledUnit(tx: PoolClient, scope: Scope) {
  await tx.query('SELECT id FROM units WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
    scope.workspaceId,
    scope.unitId,
  ]);
  const result = await tx.query(
    'SELECT id FROM labels WHERE workspace_id = $1 AND unit_id = $2 LIMIT 1',
    [scope.workspaceId, scope.unitId],
  );

  return result.rowCount === 0;
}

export async function insertLabel(
  tx: PoolClient,
  scope: Scope & { threadId: string },
  operation: { type: string; tense: string; evidenceMessageIds: string[]; confidence: number },
) {
  await tx.query(
    'INSERT INTO labels (workspace_id, unit_id, thread_id, type, tense, evidence_message_ids, confidence, vocab_version) SELECT w.id, u.id, t.id, $4, $5, $6, $7, w.vocab_version FROM workspaces w JOIN units u ON u.workspace_id = w.id JOIN threads t ON t.workspace_id = w.id WHERE w.id = $1 AND u.id = $2 AND t.id = $3 AND NOT EXISTS (SELECT 1 FROM unnest($6::uuid[]) evidence(id) WHERE NOT EXISTS (SELECT 1 FROM unit_messages um WHERE um.workspace_id = w.id AND um.unit_id = u.id AND um.message_id = evidence.id))',
    [
      scope.workspaceId,
      scope.unitId,
      scope.threadId,
      operation.type,
      operation.tense,
      operation.evidenceMessageIds,
      operation.confidence,
    ],
  );
}
