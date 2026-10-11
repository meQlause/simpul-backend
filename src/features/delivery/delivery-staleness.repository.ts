import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; threadId: string; staleSince: Date };

export async function silenceFacts(tx: PoolClient, scope: Scope) {
  const result = await tx.query<{
    reminderCreatedAt: Date | null;
    reminderSentAt: Date | null;
    escalations: number;
    escalationLimit: number;
  }>(
    `SELECT p.escalation_limit AS "escalationLimit",
    min(n.created_at) FILTER (WHERE n.kind = 'reminder') AS "reminderCreatedAt",
    min(n.sent_at) FILTER (WHERE n.kind = 'reminder') AS "reminderSentAt",
    count(n.id) FILTER (WHERE n.kind = 'escalation')::int AS escalations
    FROM policies p LEFT JOIN notifications n ON n.workspace_id = $1 AND n.thread_id = $2
      AND n.stale_since = $3 AND n.cancelled_at IS NULL
    WHERE p.workspace_id = $1 GROUP BY p.escalation_limit`,
    [scope.workspaceId, scope.threadId, scope.staleSince],
  );

  return result.rows[0];
}

export async function insertSilenceNotification(
  tx: PoolClient,
  scope: Scope,
  input: {
    kind: 'reminder' | 'escalation';
    personId: string | null;
    channelId: string;
    provider: string;
    digestId: string | null;
    body: string;
    now: Date;
  },
) {
  const result = await tx.query<{ id: string; heldUntil: Date }>(
    `INSERT INTO notifications (workspace_id, thread_id, kind, recipient_person_id, destination_channel_id,
      channel, body_rendered, held_until, created_at, stale_since, digest_id)
    SELECT $1, $2, $4, $5, CASE WHEN $5::uuid IS NULL THEN $6::uuid END, $7, $8,
      $9::timestamptz + p.hold_seconds * interval '1 second', $9, $3, $10
    FROM policies p WHERE p.workspace_id = $1
    ON CONFLICT DO NOTHING RETURNING id, held_until AS "heldUntil"`,
    [
      scope.workspaceId,
      scope.threadId,
      scope.staleSince,
      input.kind,
      input.personId,
      input.channelId,
      input.provider,
      input.body,
      input.now,
      input.digestId,
    ],
  );

  return result.rows[0];
}
