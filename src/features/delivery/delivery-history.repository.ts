import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; ruleId: string };

const historySource = `FROM labels label JOIN threads thread ON thread.id = label.thread_id AND thread.workspace_id = $1
    JOIN rules rule ON rule.workspace_id = $1 AND rule.id = $2 AND rule.domain_id = coalesce(label.domain_id, thread.domain_id)
    WHERE label.workspace_id = $1 AND label.retracted_at IS NULL AND label.confidence >= 0.75 AND label.tense = 'sudah_terjadi' AND thread.status <> 'tentative'
      AND label.created_at >= $3::timestamptz - interval '30 days' AND label.created_at <= $3
      AND rule.event_type = CASE WHEN EXISTS (SELECT 1 FROM message_thread_link link WHERE link.workspace_id = $1 AND link.thread_id = thread.id
        AND link.role = 'genesis' AND link.message_id = ANY(label.evidence_message_ids)) THEN 'new' ELSE label.type END`;

export async function historyRecipient(tx: PoolClient, scope: Scope, now: Date) {
  const result = await tx.query<{ personId: string | null }>(
    `SELECT coalesce(
    (SELECT member.person_id FROM role_members member JOIN people person ON person.id = member.person_id AND person.workspace_id = $1 AND person.active
      WHERE member.workspace_id = $1 AND member.role_id = r.recipient_role_id AND member.kind = 'member' ORDER BY member.person_id LIMIT 1), w.admin_person_id) AS "personId"
    FROM rules r JOIN workspaces w ON w.id = r.workspace_id WHERE r.workspace_id = $1 AND r.id = $2
    AND EXISTS (SELECT 1 ${historySource})`,
    [scope.workspaceId, scope.ruleId, now],
  );

  return result.rows[0]?.personId;
}

export async function gatherHistoryItems(
  tx: PoolClient,
  scope: Scope,
  input: { digestId: string; now: Date },
) {
  await tx.query(
    `INSERT INTO digest_items (workspace_id, digest_id, label_id, rule_id)
    SELECT $1, $4, label.id, rule.id ${historySource}
    ON CONFLICT DO NOTHING`,
    [scope.workspaceId, scope.ruleId, input.now, input.digestId],
  );
}
