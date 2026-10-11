import type { PoolClient } from 'pg';
import { budgetFacts, pendingDigest } from './delivery-budget.repository.js';
import { exceedsBudget } from './delivery.rules.js';

export async function budgetDigest(
  tx: PoolClient,
  scope: { workspaceId: string; personId: string },
  now: Date,
) {
  const facts = await budgetFacts(tx, scope, now);

  return exceedsBudget(facts.used, facts.budget) ? pendingDigest(tx, scope, now) : null;
}
