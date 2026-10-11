import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import type { publishUnit } from '../../platform/queue/index.js';
import { pendingMessages, storeUnit } from './ingest.coalesce.repository.js';
import { burstGroups } from './ingest.rules.js';

export type CoalesceServices = {
  resolveConnection: ConnectionResolver;
  now: () => Date;
  debounceSeconds: number;
  publishUnit?: ReturnType<typeof publishUnit>;
};

const MILLISECONDS_PER_SECOND = 1000;

export async function coalesce(
  services: CoalesceServices,
  scope: { workspaceId: string; channelId: string; senderExternalId: string },
) {
  const now = services.now().getTime();
  const debounceMs = services.debounceSeconds * MILLISECONDS_PER_SECOND;

  await scopedTransaction(services.resolveConnection, scope.workspaceId, async (tx) => {
    const messages = await pendingMessages(tx, scope);
    const latestReceivedTs = messages.reduce(
      (latest, message) => Math.max(latest, message.receivedTs),
      0,
    );

    if (!messages.length || now < latestReceivedTs + debounceMs) {
      return;
    }

    for (const group of burstGroups(messages, debounceMs)) {
      const unitId = await storeUnit(tx, scope, group);

      await services.publishUnit?.(tx, { workspaceId: scope.workspaceId, unitId });
    }
  });
}
