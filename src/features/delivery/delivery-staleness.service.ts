import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { PoolClient } from 'pg';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { silentWork } from '../work/index.js';
import { reminderRecipient } from '../people/index.js';
import { silenceFacts, insertSilenceNotification } from './delivery-staleness.repository.js';
import { stalenessStage } from './delivery-staleness.rules.js';
import { budgetDigest } from './delivery-budget.service.js';

type Services = {
  resolveConnection: ConnectionResolver;
  now: () => Date;
  publishNotification: (
    tx: PoolClient,
    scope: { workspaceId: string; notificationId: string },
    heldUntil: Date,
  ) => Promise<unknown>;
};

export async function runStaleness(services: Services, scope: { workspaceId: string }) {
  const now = services.now();

  return scopedTransaction(services.resolveConnection, scope.workspaceId, async (tx) => {
    let created = 0;

    for (const work of await silentWork(tx, scope.workspaceId, now)) {
      created += await prepareSilenceNotification(tx, {
        services,
        workspaceId: scope.workspaceId,
        now,
        work,
      });
    }

    return created;
  });
}

async function prepareSilenceNotification(
  tx: PoolClient,
  input: {
    services: Services;
    workspaceId: string;
    now: Date;
    work: Awaited<ReturnType<typeof silentWork>>[number];
  },
) {
  const { services, workspaceId, now, work } = input;
  const scope = { workspaceId, threadId: work.id, staleSince: work.lastActivityAt };
  const facts = await silenceFacts(tx, scope);
  const kind = stalenessStage({
    now: now.getTime(),
    lastActivityAt: work.lastActivityAt.getTime(),
    thresholdHours: work.thresholdHours,
    reminderCreatedAt: timestamp(facts.reminderCreatedAt),
    reminderSentAt: timestamp(facts.reminderSentAt),
    escalations: facts.escalations,
    escalationLimit: facts.escalationLimit,
  });

  if (!kind) {
    return 0;
  }

  const personId = await reminderRecipient(tx, workspaceId, {
    ownerId: work.ownerId,
    supervisor: kind === 'escalation',
  });
  const digestId = personId
    ? await budgetDigest(tx, { workspaceId, personId }, now, 'normal')
    : null;
  const notification = await insertSilenceNotification(tx, scope, {
    kind,
    personId,
    digestId,
    channelId: work.channelId,
    provider: work.provider,
    now,
    body: `${work.displayId} · ${work.customer} · ${work.summary} · still going?`,
  });

  if (notification && !digestId) {
    await services.publishNotification(
      tx,
      { workspaceId, notificationId: notification.id },
      notification.heldUntil,
    );
  }

  return Number(Boolean(notification));
}

function timestamp(value: Date | null) {
  return value?.getTime() ?? null;
}
