import type { PoolClient } from 'pg';
import { historyRecipient, gatherHistoryItems } from './delivery-history.repository.js';
import { pendingDigest, budgetFacts } from './delivery-budget.repository.js';

export async function gatherRuleHistory(
  tx: PoolClient,
  scope: { workspaceId: string; ruleId: string },
  now: Date,
) {
  const personId = await historyRecipient(tx, scope, now);

  if (!personId) {
    return;
  }

  const recipient = { workspaceId: scope.workspaceId, personId };

  await budgetFacts(tx, recipient, now);
  const digestId = await pendingDigest(tx, recipient, now);

  await gatherHistoryItems(tx, scope, { digestId, now });
}
