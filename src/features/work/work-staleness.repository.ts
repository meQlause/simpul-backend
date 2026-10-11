import type { PoolClient } from 'pg';

type SilentWork = {
  id: string;
  ownerId: string | null;
  channelId: string;
  provider: string;
  lastActivityAt: Date;
  thresholdHours: number;
  summary: string;
  displayId: string;
  customer: string;
};

export async function lockSilentWork(tx: PoolClient, workspaceId: string, now: Date) {
  const result = await tx.query<SilentWork>(
    `SELECT t.id, t.owner_person_id AS "ownerId", t.channel_id AS "channelId", c.provider,
    t.last_activity_at AS "lastActivityAt", rhythm.value::float8 AS "thresholdHours",
    t.summary, t.display_id AS "displayId", coalesce(t.customer_label, '') AS customer
    FROM threads t JOIN channels c ON c.id = t.channel_id AND c.workspace_id = $1
    JOIN LATERAL (SELECT value FROM thresholds WHERE workspace_id = $1 AND key = 'stalled_after_hours'
      AND ((scope = 'domain' AND scope_id = t.domain_id) OR scope = 'workspace')
      ORDER BY (scope = 'domain') DESC LIMIT 1) rhythm ON true
    WHERE t.workspace_id = $1 AND t.status = 'active' AND NOT t.historical
      AND c.monitored AND c.connection_status = 'active'
      AND t.last_activity_at < $2::timestamptz - rhythm.value * interval '1 hour'
    ORDER BY t.id FOR UPDATE OF t SKIP LOCKED`,
    [workspaceId, now],
  );

  return result.rows;
}
