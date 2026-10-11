import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; threadId: string };
type Progress = { opId: string; type: string; messageId: string; now: Date };

export async function applyProgress(tx: PoolClient, scope: Scope, input: Progress) {
  await tx.query('SELECT id FROM threads WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
    scope.workspaceId,
    scope.threadId,
  ]);
  const result = await tx.query(
    `INSERT INTO progress_markers (workspace_id, thread_id, op_id, ts, text, message_id, type, previous_state)
    SELECT $1, t.id, $3, $4, t.summary, m.id, $6,
      jsonb_build_object('status', t.status, 'lastActivityAt', t.last_activity_at,
        'closureKind', t.closure_kind, 'closureReason', t.closure_reason, 'closedAt', t.closed_at, 'closedBy', t.closed_by)
    FROM threads t JOIN messages_raw m ON m.workspace_id = $1 AND m.id = $5
    WHERE t.workspace_id = $1 AND t.id = $2 AND t.status = 'active' AND NOT t.historical
    ON CONFLICT (op_id) DO NOTHING RETURNING id`,
    [scope.workspaceId, scope.threadId, input.opId, input.now, input.messageId, input.type],
  );

  if (!result.rowCount) {
    return;
  }

  await tx.query(
    `UPDATE threads SET last_activity_at = $3,
    status = CASE WHEN $4 = 'resolution' THEN 'completed' ELSE status END,
    closure_kind = CASE WHEN $4 = 'resolution' THEN 'completed' ELSE closure_kind END,
    closed_at = CASE WHEN $4 = 'resolution' THEN $3 ELSE closed_at END
    WHERE workspace_id = $1 AND id = $2`,
    [scope.workspaceId, scope.threadId, input.now, input.type],
  );
}

export async function restoreProgress(
  tx: PoolClient,
  scope: Scope,
  input: { opId: string; now: Date },
) {
  await tx.query('SELECT id FROM threads WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
    scope.workspaceId,
    scope.threadId,
  ]);
  await tx.query(
    `WITH operation AS (
      UPDATE progress_markers SET retracted_at = $4
      WHERE workspace_id = $1 AND thread_id = $2 AND op_id = $3 AND retracted_at IS NULL
      RETURNING previous_state, ts)
    UPDATE threads t SET status = operation.previous_state->>'status',
      last_activity_at = (operation.previous_state->>'lastActivityAt')::timestamptz,
      closure_kind = operation.previous_state->>'closureKind', closure_reason = operation.previous_state->>'closureReason',
      closed_at = (operation.previous_state->>'closedAt')::timestamptz,
      closed_by = (operation.previous_state->>'closedBy')::uuid
    FROM operation WHERE t.workspace_id = $1 AND t.id = $2 AND t.last_activity_at = operation.ts`,
    [scope.workspaceId, scope.threadId, input.opId, input.now],
  );
}
