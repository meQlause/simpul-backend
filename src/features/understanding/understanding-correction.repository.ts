import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; unitId: string };

export type CorrectionFacts = {
  channelId: string;
  messageIds: string[];
  startedThreadId: string | null;
  currentThreadId: string | null;
  labels: { opId: string; threadId: string | null }[];
};

// What the unit is on now, read without a lock: the draft checks it before the model is called.
export async function loadCorrectionFacts(tx: PoolClient, scope: Scope) {
  const result = await tx.query<CorrectionFacts>(
    `SELECT u.channel_id AS "channelId",
      COALESCE((SELECT array_agg(um.message_id) FROM unit_messages um WHERE um.unit_id = u.id), '{}') AS "messageIds",
      genesis.thread_id AS "startedThreadId",
      COALESCE(last.thread_id, live.thread_id, genesis.thread_id) AS "currentThreadId",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('opId', l.op_id, 'threadId', l.thread_id))
        FROM labels l WHERE l.unit_id = u.id AND l.retracted_at IS NULL), '[]'::jsonb) AS labels
    FROM units u
    LEFT JOIN LATERAL (SELECT mtl.thread_id FROM unit_messages um
      JOIN message_thread_link mtl ON mtl.message_id = um.message_id AND mtl.role = 'genesis'
      WHERE um.unit_id = u.id LIMIT 1) genesis ON true
    LEFT JOIN LATERAL (SELECT uc.thread_id FROM unit_corrections uc WHERE uc.unit_id = u.id
      ORDER BY uc.created_at DESC LIMIT 1) last ON true
    LEFT JOIN LATERAL (SELECT l.thread_id FROM labels l
      WHERE l.unit_id = u.id AND l.retracted_at IS NULL LIMIT 1) live ON true
    WHERE u.workspace_id = $1 AND u.id = $2`,
    [scope.workspaceId, scope.unitId],
  );

  return result.rows[0];
}

// The same facts, under a row lock: a second correction of the unit waits for the first to commit
// and then sees its result.
export async function lockCorrectionUnit(tx: PoolClient, scope: Scope) {
  await tx.query('SELECT id FROM units WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
    scope.workspaceId,
    scope.unitId,
  ]);

  return loadCorrectionFacts(tx, scope);
}

// The target work by its display id. A tentative item past its expiry counts as expired.
export async function openTarget(
  tx: PoolClient,
  workspaceId: string,
  displayId: string,
  now: Date,
) {
  const result = await tx.query<{ id: string; displayId: string; status: string }>(
    `SELECT id, display_id AS "displayId",
      CASE WHEN status = 'tentative' AND expires_at <= $3 THEN 'expired' ELSE status END AS status
     FROM threads WHERE workspace_id = $1 AND display_id = $2`,
    [workspaceId, displayId, now],
  );

  return result.rows[0];
}

export async function closeOrphan(tx: PoolClient, scope: Scope, now: Date) {
  await tx.query(
    'UPDATE orphans SET closed_at = $3 WHERE workspace_id = $1 AND unit_id = $2 AND closed_at IS NULL',
    [scope.workspaceId, scope.unitId, now],
  );
}

export async function closeQuestion(tx: PoolClient, scope: Scope, actorId: string) {
  await tx.query(
    "UPDATE open_questions SET answer = 'admin', answered_by = $3 WHERE workspace_id = $1 AND unit_id = $2 AND answer IS NULL",
    [scope.workspaceId, scope.unitId, actorId],
  );
}

export async function markAdminResolution(
  tx: PoolClient,
  scope: Scope,
  input: { verdict: 'ATTACH' | 'CREATE'; threadId: string },
) {
  await tx.query(
    `INSERT INTO unit_resolutions (workspace_id, unit_id, verdict, decided_by, chosen_thread_id)
     VALUES ($1, $2, $3, 'admin', $4)
     ON CONFLICT (unit_id) DO UPDATE SET decided_by = 'admin', chosen_thread_id = excluded.chosen_thread_id`,
    [scope.workspaceId, scope.unitId, input.verdict, input.threadId],
  );
}

export async function insertCorrection(
  tx: PoolClient,
  scope: Scope,
  input: {
    action: 'create' | 'attach';
    threadId: string;
    previousOutcome: string;
    actorId: string;
    now: Date;
  },
) {
  await tx.query(
    `INSERT INTO unit_corrections (workspace_id, unit_id, action, thread_id, previous_outcome, corrected_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      scope.workspaceId,
      scope.unitId,
      input.action,
      input.threadId,
      input.previousOutcome,
      input.actorId,
      input.now,
    ],
  );
}
