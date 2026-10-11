import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; digestId: string };

export async function dueDigests(tx: PoolClient, workspaceId: string, now: Date) {
  return (
    await tx.query<{ id: string; personId: string; name: string; email: string }>(
      `SELECT d.id, p.id AS "personId", p.name, p.email FROM digests d JOIN people p
      ON p.workspace_id = $1 AND p.id = d.recipient_person_id AND p.active
    WHERE d.workspace_id = $1 AND d.sent_at IS NULL AND d.scheduled_for <= $2 AND p.email IS NOT NULL
    ORDER BY d.scheduled_for, d.id FOR UPDATE OF d SKIP LOCKED`,
      [workspaceId, now],
    )
  ).rows;
}

export async function digestLines(tx: PoolClient, scope: Scope, now: Date) {
  return (
    await tx.query<{ text: string }>(
      `SELECT n.body_rendered AS text FROM notifications n LEFT JOIN labels l
      ON l.workspace_id = $1 AND l.id = n.label_id
    LEFT JOIN rules r ON r.workspace_id = $1 AND r.id = n.rule_id
    LEFT JOIN threads t ON t.workspace_id = $1 AND t.id = n.thread_id
    WHERE n.workspace_id = $1 AND n.digest_id = $2 AND n.sent_at IS NULL AND n.cancelled_at IS NULL
      AND n.held_until <= $3 AND l.retracted_at IS NULL AND coalesce(r.active, true)
      AND (n.kind NOT IN ('reminder','escalation') OR (t.status = 'active' AND NOT t.historical
        AND (n.stale_since IS NULL OR n.stale_since = t.last_activity_at)))
    UNION ALL SELECT t.display_id || ': ' || t.summary FROM digest_items item
      JOIN labels l ON l.workspace_id = $1 AND l.id = item.label_id AND l.retracted_at IS NULL
      JOIN rules r ON r.workspace_id = $1 AND r.id = item.rule_id AND r.active
      JOIN threads t ON t.workspace_id = $1 AND t.id = l.thread_id
    WHERE item.workspace_id = $1 AND item.digest_id = $2`,
      [scope.workspaceId, scope.digestId, now],
    )
  ).rows;
}

export async function finishDigest(tx: PoolClient, scope: Scope, now: Date) {
  await tx.query('UPDATE digests SET sent_at = $3 WHERE workspace_id = $1 AND id = $2', [
    scope.workspaceId,
    scope.digestId,
    now,
  ]);
  await tx.query(
    `UPDATE notifications n SET sent_at = $3 WHERE n.workspace_id = $1 AND n.digest_id = $2
    AND n.sent_at IS NULL AND n.cancelled_at IS NULL AND n.held_until <= $3
    AND NOT EXISTS (SELECT 1 FROM labels l WHERE l.id = n.label_id AND l.retracted_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM rules r WHERE r.id = n.rule_id AND NOT r.active)
    AND (n.kind NOT IN ('reminder','escalation') OR EXISTS (SELECT 1 FROM threads t WHERE t.id = n.thread_id
      AND t.status = 'active' AND NOT t.historical AND (n.stale_since IS NULL OR n.stale_since = t.last_activity_at)))`,
    [scope.workspaceId, scope.digestId, now],
  );
}

export async function heldDigestItems(tx: PoolClient, scope: Scope, now: Date) {
  return (
    await tx.query(
      `SELECT id FROM notifications WHERE workspace_id = $1 AND digest_id = $2
    AND sent_at IS NULL AND cancelled_at IS NULL AND held_until > $3 LIMIT 1`,
      [scope.workspaceId, scope.digestId, now],
    )
  ).rowCount;
}

export async function moveHeldItems(
  tx: PoolClient,
  scope: Scope,
  input: { nextDigestId: string; now: Date },
) {
  await tx.query(
    `UPDATE notifications SET digest_id = $3 WHERE workspace_id = $1 AND digest_id = $2
    AND sent_at IS NULL AND cancelled_at IS NULL AND held_until > $4`,
    [scope.workspaceId, scope.digestId, input.nextDigestId, input.now],
  );
}
