import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; personId: string };

export async function budgetFacts(tx: PoolClient, scope: Scope, now: Date) {
  await tx.query('SELECT id FROM people WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
    scope.workspaceId,
    scope.personId,
  ]);
  const result = await tx.query<{
    used: number;
    budget: number;
    localTime: string;
    quietStart: string;
    quietEnd: string;
  }>(
    `SELECT p.budget_per_hour AS budget, to_char($3::timestamptz AT TIME ZONE w.timezone, 'HH24:MI') AS "localTime",
      left(p.quiet_start::text, 5) AS "quietStart", left(p.quiet_end::text, 5) AS "quietEnd", (SELECT count(*)::int FROM notifications n
      WHERE n.workspace_id = $1 AND n.recipient_person_id = $2 AND n.cancelled_at IS NULL AND n.digest_id IS NULL
        AND ((n.sent_at > $3::timestamptz - interval '1 hour' AND n.sent_at <= $3)
          OR (n.sent_at IS NULL AND n.created_at > $3::timestamptz - interval '1 hour' AND n.created_at <= $3))) AS used
    FROM policies p JOIN workspaces w ON w.id = p.workspace_id WHERE p.workspace_id = $1`,
    [scope.workspaceId, scope.personId, now],
  );

  return result.rows[0];
}

export async function pendingDigest(tx: PoolClient, scope: Scope, now: Date) {
  const existing = await tx.query<{ id: string }>(
    'SELECT id FROM digests WHERE workspace_id = $1 AND recipient_person_id = $2 AND sent_at IS NULL ORDER BY scheduled_for, id LIMIT 1',
    [scope.workspaceId, scope.personId],
  );

  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  const result = await tx.query<{ id: string }>(
    `INSERT INTO digests (workspace_id, recipient_person_id, scheduled_for, created_at)
    SELECT $1, $2, (CASE WHEN ($3::timestamptz AT TIME ZONE w.timezone)::time < p.digest_time
      THEN ($3::timestamptz AT TIME ZONE w.timezone)::date + p.digest_time
      ELSE ($3::timestamptz AT TIME ZONE w.timezone)::date + 1 + p.digest_time END) AT TIME ZONE w.timezone, $3
    FROM policies p JOIN workspaces w ON w.id = p.workspace_id WHERE w.id = $1 RETURNING id`,
    [scope.workspaceId, scope.personId, now],
  );

  return result.rows[0].id;
}
