import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; notificationId: string };
type Pending = {
  provider: string;
  connectionId: string;
  providerAccountId: string;
  tokenRef: string;
  chatId: string;
  body: string;
  work_id: string;
  customer: string;
  summary: string;
};

export async function lockPendingNotification(tx: PoolClient, scope: Scope, now: Date) {
  await tx.query(
    `SELECT l.id FROM labels l JOIN notifications n ON n.label_id = l.id AND n.workspace_id = $1
    WHERE l.workspace_id = $1 AND n.id = $2 FOR UPDATE OF l`,
    [scope.workspaceId, scope.notificationId],
  );
  const result = await tx.query<Pending>(
    `SELECT c.provider, b.id AS "connectionId", b.provider_account_id AS "providerAccountId",
      b.token_secret_ref AS "tokenRef", coalesce(identity.external_id, identity.handle) AS "chatId", template.body AS body, t.display_id AS work_id, coalesce(t.customer_label, '') AS customer, t.summary
    FROM notifications n JOIN labels l ON l.id = n.label_id AND l.workspace_id = $1
    JOIN units u ON u.id = l.unit_id AND u.workspace_id = $1
    JOIN channels c ON c.id = u.channel_id AND c.workspace_id = $1
    JOIN bot_connections b ON b.id = c.bot_connection_id AND b.workspace_id = $1
    JOIN threads t ON t.id = n.thread_id AND t.workspace_id = $1
    JOIN templates template ON template.workspace_id = $1 AND template.audience = c.class AND template.key = 'update'
    JOIN person_identities identity ON identity.person_id = n.recipient_person_id AND identity.workspace_id = $1 AND identity.provider = c.provider
    WHERE n.workspace_id = $1 AND n.id = $2 AND n.sent_at IS NULL AND n.cancelled_at IS NULL
      AND n.digest_id IS NULL AND n.held_until <= $3 AND l.retracted_at IS NULL
      AND c.monitored AND c.connection_status = 'active' FOR UPDATE OF n`,
    [scope.workspaceId, scope.notificationId, now],
  );

  return result.rows[0];
}

export async function recordSentAt(
  tx: PoolClient,
  scope: Scope,
  input: { now: Date; body: string },
) {
  await tx.query(
    'UPDATE notifications SET sent_at = $3, body_rendered = $4 WHERE workspace_id = $1 AND id = $2',
    [scope.workspaceId, scope.notificationId, input.now, input.body],
  );
}

export async function deferNotification(
  tx: PoolClient,
  scope: Scope,
  input: { now: Date; retryAfter: number },
) {
  await tx.query(
    "UPDATE notifications SET held_until = $3::timestamptz + $4 * interval '1 second' WHERE workspace_id = $1 AND id = $2",
    [scope.workspaceId, scope.notificationId, input.now, input.retryAfter],
  );
}
