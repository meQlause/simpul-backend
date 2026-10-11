import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { PoolClient } from 'pg';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { resolveRoleRecipientInTransaction } from '../people/index.js';
import { claimGate, mergeRecipientRules, renderNotification } from './delivery.rules.js';
import {
  lockRoutingLabel,
  matchingRules,
  recordMatches,
  prepareNotification,
  markRouted,
} from './delivery-routing.repository.js';

type Services = { resolveConnection: ConnectionResolver; now: () => Date };
type Scope = { workspaceId: string; labelId: string };

export async function routeLabel(services: Services, scope: Scope) {
  return scopedTransaction(services.resolveConnection, scope.workspaceId, async (tx) => {
    const label = await lockRoutingLabel(tx, scope);

    if (!label || !claimGate(label, label)) {
      return;
    }

    const rules = await matchingRules(tx, scope.workspaceId, label);

    if (!rules.length) {
      return;
    }

    const matches = await resolveRecipients(tx, scope.workspaceId, label.channelId, rules);
    const now = services.now();
    const body = renderNotification(label.template, {
      work_id: label.displayId,
      customer: label.customer,
      summary: label.summary,
    });

    await recordMatches(
      tx,
      scope,
      rules.map((rule) => rule.ruleId),
      now,
    );

    for (const recipient of mergeRecipientRules(matches)) {
      await prepareNotification(tx, scope, { label, recipient, body }, now);
    }

    await markRouted(tx, scope, now);
  });
}

async function resolveRecipients(
  tx: PoolClient,
  workspaceId: string,
  channelId: string,
  rules: Awaited<ReturnType<typeof matchingRules>>,
) {
  const resolved = [];

  for (const rule of rules) {
    const recipient = await resolveRoleRecipientInTransaction(
      tx,
      workspaceId,
      rule.roleId,
      channelId,
    );

    if (recipient.kind !== 'person' || !recipient.personId) {
      throw new DomainError('E-INTERNAL');
    }

    resolved.push({ ...rule, personId: recipient.personId });
  }

  return resolved;
}
