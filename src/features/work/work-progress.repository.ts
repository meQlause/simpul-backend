import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; threadId: string };
type Progress = {
  opId: string;
  type: string;
  messageId: string;
  now: Date;
  confirmation?: { actorId: string; id: string };
};

export async function applyProgress(tx: PoolClient, scope: Scope, input: Progress) {
  await tx.query('SELECT id FROM threads WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
    scope.workspaceId,
    scope.threadId,
  ]);
  const result = await tx.query(
    `INSERT INTO progress_markers (workspace_id, thread_id, op_id, ts, text, message_id, type, confirmed_by, confirmation_id, previous_state)
    SELECT $1, t.id, $3, $4, t.summary, m.id, $6, $7, $8,
      jsonb_build_object('status', t.status, 'lastActivityAt', t.last_activity_at,
        'closureKind', t.closure_kind, 'closureReason', t.closure_reason, 'closedAt', t.closed_at, 'closedBy', t.closed_by,
        'previousOpId', (SELECT prior.op_id FROM progress_markers prior
          WHERE prior.workspace_id = $1 AND prior.thread_id = t.id AND prior.ts = t.last_activity_at AND prior.op_id IS NOT NULL AND prior.retracted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM progress_markers successor WHERE successor.workspace_id = $1 AND successor.thread_id = t.id
            AND successor.retracted_at IS NULL AND successor.previous_state->>'previousOpId' = prior.op_id::text)
          ORDER BY prior.created_at DESC, prior.id DESC LIMIT 1))
    FROM threads t JOIN messages_raw m ON m.workspace_id = $1 AND m.id = $5
    WHERE t.workspace_id = $1 AND t.id = $2 AND t.status = 'active' AND NOT t.historical
    ON CONFLICT (op_id) DO UPDATE SET ts = excluded.ts, type = excluded.type,
      confirmed_by = excluded.confirmed_by, confirmation_id = excluded.confirmation_id
    WHERE $7::uuid IS NOT NULL AND progress_markers.workspace_id = $1 AND progress_markers.thread_id = $2
      AND progress_markers.retracted_at IS NULL AND progress_markers.confirmation_id IS DISTINCT FROM $8
    RETURNING id`,
    [
      scope.workspaceId,
      scope.threadId,
      input.opId,
      input.now,
      input.messageId,
      input.type,
      input.confirmation?.actorId ?? null,
      input.confirmation?.id ?? null,
    ],
  );

  if (!result.rowCount) {
    return false;
  }

  await tx.query(
    `UPDATE threads SET last_activity_at = $3,
    status = CASE WHEN $4 = 'resolution' THEN 'completed' ELSE status END,
    closure_kind = CASE WHEN $4 = 'resolution' THEN 'completed' ELSE closure_kind END,
    closed_at = CASE WHEN $4 = 'resolution' THEN $3 ELSE closed_at END
    WHERE workspace_id = $1 AND id = $2`,
    [scope.workspaceId, scope.threadId, input.now, input.type],
  );

  return true;
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
    FROM operation WHERE t.workspace_id = $1 AND t.id = $2 AND t.last_activity_at = operation.ts
      AND NOT EXISTS (SELECT 1 FROM progress_markers successor WHERE successor.workspace_id = $1 AND successor.thread_id = $2
        AND successor.retracted_at IS NULL AND successor.previous_state->>'previousOpId' = $3::text)`,
    [scope.workspaceId, scope.threadId, input.opId, input.now],
  );
  await tx.query(
    `UPDATE progress_markers successor SET previous_state = operation.previous_state
    FROM progress_markers operation WHERE operation.workspace_id = $1 AND operation.thread_id = $2 AND operation.op_id = $3
      AND successor.workspace_id = $1 AND successor.thread_id = $2 AND successor.retracted_at IS NULL
      AND successor.previous_state->>'previousOpId' = operation.op_id::text`,
    [scope.workspaceId, scope.threadId, input.opId],
  );
  await tx.query(
    `DELETE FROM message_thread_link link WHERE link.workspace_id = $1 AND link.thread_id = $2
    AND link.role = 'state_change' AND link.message_id = ANY(SELECT unnest(evidence_message_ids) FROM labels WHERE workspace_id = $1 AND op_id = $3)
    AND NOT EXISTS (SELECT 1 FROM labels sibling WHERE sibling.workspace_id = $1 AND sibling.thread_id = $2 AND sibling.op_id <> $3
      AND sibling.retracted_at IS NULL AND link.message_id = ANY(sibling.evidence_message_ids))`,
    [scope.workspaceId, scope.threadId, input.opId],
  );
}
