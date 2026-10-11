import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { ruleRows, ruleEstimate } from './rules.repository.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import type { parseRuleEstimate } from './rules-write.schema.js';

export function listRules(resolveConnection: ConnectionResolver, workspaceId: string, now: Date) {
  return scopedTransaction(resolveConnection, workspaceId, (tx) => ruleRows(tx, workspaceId, now));
}

export function estimateRule(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
  input: ReturnType<typeof parseRuleEstimate>,
  now: Date,
) {
  return scopedTransaction(resolveConnection, workspaceId, async (tx) => {
    const estimate = await ruleEstimate(tx, workspaceId, input, now);

    if (!estimate) {
      throw new DomainError('E-VALIDATION');
    }

    return estimate;
  });
}
