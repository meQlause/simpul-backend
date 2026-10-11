import type { PoolClient } from 'pg';
import { budgetFacts, pendingDigest } from './delivery-budget.repository.js';
import { exceedsBudget, quietHoursHold } from './delivery.rules.js';

export async function budgetDigest(
  tx: PoolClient,
  scope: { workspaceId: string; personId: string },
  now: Date,
  urgency: string,
) {
  const facts = await budgetFacts(tx, scope, now);

  return facts.executive ||
    exceedsBudget(facts.used, facts.budget) ||
    quietHoursHold({ ...facts, urgency })
    ? pendingDigest(tx, scope, now)
    : null;
}
