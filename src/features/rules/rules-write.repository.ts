import type { PoolClient } from 'pg';

export type RuleWrite = {
  name: string;
  categoryId: string;
  eventType: string;
  conditionText: string;
  recipientRoleId: string;
  historyMode: string;
  active: boolean;
};

export async function lockRuleWrite(tx: PoolClient, workspaceId: string, ruleId: string) {
  const result = await tx.query<RuleWrite>(
    `SELECT name, domain_id AS "categoryId", event_type AS "eventType", condition_text AS "conditionText",
    recipient_role_id AS "recipientRoleId", history_mode AS "historyMode", active FROM rules WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [workspaceId, ruleId],
  );

  return result.rows[0];
}

export async function storeRuleWrite(
  tx: PoolClient,
  scope: { workspaceId: string; ruleId?: string },
  input: RuleWrite,
) {
  const references = await tx.query<{ templateId: string }>(
    `SELECT template.id AS "templateId" FROM vocab_domains domain
    JOIN roles role ON role.workspace_id = $1 AND role.id = $3 AND role.active
    JOIN templates template ON template.workspace_id = $1 AND template.audience = 'internal' AND template.key = 'update'
    WHERE domain.workspace_id = $1 AND domain.id = $2 AND domain.active FOR SHARE OF domain, role, template`,
    [scope.workspaceId, input.categoryId, input.recipientRoleId],
  );

  if (!references.rowCount) {
    return undefined;
  }

  const result = await tx.query<{ id: string }>(
    scope.ruleId
      ? `UPDATE rules SET name = $2, domain_id = $3, event_type = $4, condition_text = $5, recipient_role_id = $6, history_mode = $7, active = $8, template_id = $9 WHERE workspace_id = $1 AND id = $10 RETURNING id`
      : `INSERT INTO rules (workspace_id, name, domain_id, event_type, condition_text, recipient_role_id, history_mode, active, template_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    scope.ruleId
      ? [
          scope.workspaceId,
          input.name,
          input.categoryId,
          input.eventType,
          input.conditionText,
          input.recipientRoleId,
          input.historyMode,
          input.active,
          references.rows[0].templateId,
          scope.ruleId,
        ]
      : [
          scope.workspaceId,
          input.name,
          input.categoryId,
          input.eventType,
          input.conditionText,
          input.recipientRoleId,
          input.historyMode,
          input.active,
          references.rows[0].templateId,
        ],
  );

  return result.rows[0]?.id;
}
