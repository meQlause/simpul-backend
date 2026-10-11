import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; unitId: string };

export async function runtimeUnit(tx: PoolClient, scope: Scope) {
  return (
    await tx.query<{
      unitId: string;
      channelId: string;
      senderId: string | null;
      explicitIds: string[];
      replyIds: string[];
      bodySafe: string;
      triageClass: string;
    }>(
      `SELECT u.id AS "unitId", u.channel_id AS "channelId", u.sender_id AS "senderId", u.explicit_ids AS "explicitIds",
      u.triage_class AS "triageClass", array_remove(array_agg(m.reply_to_id), NULL) AS "replyIds",
      string_agg(m.body_safe, E'\n' ORDER BY m.server_ts, m.id) AS "bodySafe"
    FROM units u JOIN unit_messages um ON um.unit_id = u.id AND um.workspace_id = $1
    JOIN messages_raw m ON m.id = um.message_id AND m.workspace_id = $1
    WHERE u.workspace_id = $1 AND u.id = $2 GROUP BY u.id`,
      [scope.workspaceId, scope.unitId],
    )
  ).rows[0];
}

export async function scoringWeights(tx: PoolClient, workspaceId: string) {
  const defaults = { identity: 0.3, temporal: 0.25, social: 0.2, procedural: 0.15, semantic: 0.1 };
  const result = await tx.query<{ key: keyof typeof defaults; value: number }>(
    "SELECT replace(key, 'weight_', '') AS key, value::float8 AS value FROM thresholds WHERE workspace_id = $1 AND scope = 'workspace' AND key LIKE 'weight_%'",
    [workspaceId],
  );

  return { ...defaults, ...Object.fromEntries(result.rows.map((row) => [row.key, row.value])) };
}
