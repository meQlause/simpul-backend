import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; threadId: string };

export async function operationContext(tx: PoolClient, scope: Scope) {
  const { rows } = await tx.query<{ opId: string; type: string; evidence: string }>(
    `SELECT l.op_id AS "opId", l.type, string_agg(m.body_safe, E'\n' ORDER BY m.server_ts, m.id) AS evidence
    FROM (SELECT label.*, unit.ts_last AS source_at FROM labels label
      JOIN units unit ON unit.id = label.unit_id AND unit.workspace_id = $1
      WHERE label.workspace_id = $1 AND label.thread_id = $2 AND label.retracted_at IS NULL
      ORDER BY unit.ts_last DESC, label.created_at DESC, label.id DESC LIMIT 50) l
    JOIN messages_raw m ON m.workspace_id = $1 AND m.id = ANY(l.evidence_message_ids)
    GROUP BY l.id, l.op_id, l.type, l.source_at, l.created_at ORDER BY l.source_at DESC, l.created_at DESC, l.id DESC`,
    [scope.workspaceId, scope.threadId],
  );

  return rows;
}

export async function retireOperation(
  tx: PoolClient,
  scope: Scope,
  input: { opId: string; now: Date },
) {
  const result = await tx.query(
    `UPDATE labels SET retracted_at = $4
    WHERE workspace_id = $1 AND thread_id = $2 AND op_id = $3 AND retracted_at IS NULL RETURNING id`,
    [scope.workspaceId, scope.threadId, input.opId, input.now],
  );

  return result.rowCount === 1;
}

export async function detachRecordedOperation(
  tx: PoolClient,
  scope: Scope,
  input: { opId: string; now: Date },
) {
  await tx.query(
    'UPDATE labels SET thread_id = NULL, retracted_at = $4 WHERE workspace_id = $1 AND thread_id = $2 AND op_id = $3',
    [scope.workspaceId, scope.threadId, input.opId, input.now],
  );
}
