import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { saveOnboardingBackups } from '../people/index.js';
import { saveOnboardingRules } from '../rules/index.js';
import { hasActiveVerifiedGroup } from '../channels/index.js';
import { recordConfigChange } from '../audit/index.js';
import { lockOnboarding, stampOnboarding } from './workspace-onboarding.repository.js';
import type { parseOnboarding } from './workspace-onboarding.schema.js';

export async function completeOnboarding(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; actorId: string },
  input: ReturnType<typeof parseOnboarding>,
  now: Date,
) {
  return scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
    const before = await lockOnboarding(tx, scope.workspaceId);

    if (!before) {
      throw new DomainError('E-NOT-FOUND');
    }

    const backupsBefore = await saveOnboardingBackups(tx, scope.workspaceId, input.backups);

    if (!(await hasActiveVerifiedGroup(tx, scope.workspaceId))) {
      throw new DomainError('E-ONBOARDING-NO-ACTIVE-GROUP');
    }

    const rulesBefore = await saveOnboardingRules(tx, scope.workspaceId, input.activeRuleIds);
    const after = await stampOnboarding(tx, scope.workspaceId, now);

    await recordConfigChange(tx, {
      ...scope,
      tableName: 'workspaces',
      recordId: scope.workspaceId,
      before: { ...before, backups: backupsBefore, activeRuleIds: rulesBefore },
      after: { ...after, backups: input.backups, activeRuleIds: input.activeRuleIds },
    });

    return after;
  });
}
