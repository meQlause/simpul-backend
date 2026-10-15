import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; unitId: string };

export async function modelInput(tx: PoolClient, scope: Scope) {
  const { rows } = await tx.query<{
    bodySafe: string;
    triageClass: string | null;
    evidenceMessageIds: string[];
    localDate: string;
    weekday: string;
  }>(
    `SELECT u.triage_class AS "triageClass", array_agg(m.id ORDER BY m.server_ts, m.id) AS "evidenceMessageIds",
      CASE WHEN u.source = 'transcript' THEN u.text ELSE string_agg(m.body_safe, E'\n' ORDER BY m.server_ts, m.id) END AS "bodySafe",
      to_char((u.ts_first AT TIME ZONE w.timezone)::date, 'YYYY-MM-DD') AS "localDate",
      trim(to_char(u.ts_first AT TIME ZONE w.timezone, 'FMDay')) AS weekday
    FROM units u JOIN workspaces w ON w.id = u.workspace_id
    JOIN unit_messages um ON um.unit_id = u.id AND um.workspace_id = u.workspace_id
    JOIN messages_raw m ON m.id = um.message_id AND m.workspace_id = u.workspace_id
    WHERE u.workspace_id = $1 AND u.id = $2 GROUP BY u.id, w.timezone`,
    [scope.workspaceId, scope.unitId],
  );

  return rows[0];
}

export async function markInjection(tx: PoolClient, scope: Scope) {
  const { rowCount } = await tx.query(
    'UPDATE units SET injection_suspected = true WHERE workspace_id = $1 AND id = $2 AND NOT injection_suspected',
    [scope.workspaceId, scope.unitId],
  );

  return rowCount === 1;
}

export async function storeTriage(
  tx: PoolClient,
  scope: Scope,
  triage: { triageClass: string; referencedDate: string | null },
) {
  const { rowCount } = await tx.query(
    'UPDATE units SET triage_class = $3, referenced_date = $4::date WHERE workspace_id = $1 AND id = $2 AND triage_class IS NULL',
    [scope.workspaceId, scope.unitId, triage.triageClass, triage.referencedDate],
  );

  return rowCount === 1;
}
