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
  roleId: string | null;
  originChannelId: string;
  personId: string | null;
  destinationChannelId: string | null;
};

export async function lockPendingNotification(tx: PoolClient, scope: Scope, now: Date) {
  await tx.query(
    `SELECT l.id FROM labels l JOIN notifications n ON n.label_id = l.id AND n.workspace_id = $1
    WHERE l.workspace_id = $1 AND n.id = $2 FOR UPDATE OF l`,
    [scope.workspaceId, scope.notificationId],
  );
  const result = await tx.query<Pending>(
    `SELECT c.provider, b.id AS "connectionId", b.provider_account_id AS "providerAccountId",
      b.token_secret_ref AS "tokenRef", coalesce(identity.external_id, identity.handle, c.provider_chat_id) AS "chatId",
      rule.recipient_role_id AS "roleId", c.id AS "originChannelId", n.recipient_person_id AS "personId",
      n.destination_channel_id AS "destinationChannelId", template.body AS body, t.display_id AS work_id, coalesce(t.customer_label, '') AS customer, t.summary
    FROM notifications n JOIN labels l ON l.id = n.label_id AND l.workspace_id = $1
    JOIN units u ON u.id = l.unit_id AND u.workspace_id = $1
    JOIN channels c ON c.id = u.channel_id AND c.workspace_id = $1
    JOIN bot_connections b ON b.id = c.bot_connection_id AND b.workspace_id = $1
    JOIN threads t ON t.id = n.thread_id AND t.workspace_id = $1
    JOIN templates template ON template.workspace_id = $1 AND template.audience = c.class AND template.key = 'update'
    LEFT JOIN rules rule ON rule.id = n.rule_id AND rule.workspace_id = $1
    LEFT JOIN person_identities identity ON identity.person_id = n.recipient_person_id AND identity.workspace_id = $1 AND identity.provider = c.provider
    WHERE n.workspace_id = $1 AND n.id = $2 AND n.sent_at IS NULL AND n.cancelled_at IS NULL
      AND n.digest_id IS NULL AND n.held_until <= $3 AND l.retracted_at IS NULL
      AND c.monitored AND c.connection_status = 'active' FOR UPDATE OF n`,
    [scope.workspaceId, scope.notificationId, now],
  );

  return result.rows[0];
}

export async function replaceDestination(
  tx: PoolClient,
  scope: Scope,
  destination: { personId: string | null; channelId: string | null; provider: string; now: Date },
) {
  const duplicate = await tx.query(
    `SELECT other.id FROM notifications current JOIN notifications other
    ON other.workspace_id = current.workspace_id AND other.label_id = current.label_id AND other.kind = current.kind
    WHERE current.workspace_id = $1 AND current.id = $2 AND other.id <> current.id AND other.cancelled_at IS NULL
      AND other.recipient_person_id IS NOT DISTINCT FROM $3::uuid AND other.destination_channel_id IS NOT DISTINCT FROM $4::uuid`,
    [scope.workspaceId, scope.notificationId, destination.personId, destination.channelId],
  );

  if (duplicate.rowCount) {
    await tx.query(
      'UPDATE notifications SET cancelled_at = $3 WHERE workspace_id = $1 AND id = $2',
      [scope.workspaceId, scope.notificationId, destination.now],
    );

    return null;
  }

  const result = await tx.query<{ chatId: string }>(
    `SELECT coalesce(identity.external_id, identity.handle, channel.provider_chat_id) AS "chatId"
    FROM (SELECT 1) source LEFT JOIN person_identities identity ON identity.workspace_id = $1 AND identity.person_id = $2 AND identity.provider = $4
    LEFT JOIN channels channel ON channel.workspace_id = $1 AND channel.id = $3`,
    [scope.workspaceId, destination.personId, destination.channelId, destination.provider],
  );

  await tx.query(
    'UPDATE notifications SET recipient_person_id = $3, destination_channel_id = $4 WHERE workspace_id = $1 AND id = $2',
    [scope.workspaceId, scope.notificationId, destination.personId, destination.channelId],
  );

  return result.rows[0].chatId;
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
