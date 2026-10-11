import type { PoolClient } from 'pg';

export async function activateSelectedRules(
  tx: PoolClient,
  workspaceId: string,
  ruleIds: string[],
) {
  const rules = await tx.query<{ id: string; active: boolean }>(
    'SELECT id, active FROM rules WHERE workspace_id = $1 FOR UPDATE',
    [workspaceId],
  );

  if (ruleIds.some((id) => !rules.rows.some((rule) => rule.id === id))) {
    return undefined;
  }

  await tx.query('UPDATE rules SET active = id = ANY($2::uuid[]) WHERE workspace_id = $1', [
    workspaceId,
    ruleIds,
  ]);

  return rules.rows.filter((rule) => rule.active).map((rule) => rule.id);
}
