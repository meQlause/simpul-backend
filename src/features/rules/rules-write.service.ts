import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordConfigChange } from '../audit/index.js';
import { gatherRuleHistory } from '../delivery/index.js';
import { resolveRoutingReview } from '../review-queue/index.js';
import { ruleRows } from './rules.repository.js';
import { lockRuleWrite, storeRuleWrite, type RuleWrite } from './rules-write.repository.js';
import type { parseRuleWrite } from './rules-write.schema.js';
import { gathersHistory } from './rules-write.rules.js';

export async function saveRule(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; actorId: string; ruleId?: string },
  input: ReturnType<typeof parseRuleWrite>,
  now: Date,
) {
  return scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
    const before = scope.ruleId ? await lockRuleWrite(tx, scope.workspaceId, scope.ruleId) : null;

    if (scope.ruleId && !before) {
      throw new DomainError('E-NOT-FOUND');
    }

    const values = { active: true, ...before, ...input } as RuleWrite;
    const ruleId = await storeRuleWrite(tx, scope, values);

    if (!ruleId) {
      throw new DomainError('E-VALIDATION');
    }

    if ('reviewItemId' in input && input.reviewItemId) {
      await resolveRoutingReview(tx, scope, input.reviewItemId, now);
    }

    if (gathersHistory(values, before === null, Object.keys(input))) {
      await gatherRuleHistory(tx, { workspaceId: scope.workspaceId, ruleId }, now);
    }

    await recordConfigChange(tx, {
      ...scope,
      tableName: 'rules',
      recordId: ruleId,
      before,
      after: values,
    });

    return (await ruleRows(tx, scope.workspaceId, now)).find((rule) => rule.id === ruleId);
  });
}
