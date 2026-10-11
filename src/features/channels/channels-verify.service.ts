import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { cancelChannelNotifications } from '../delivery/index.js';
import type { ActivationServices } from './activation.service.js';
import { VERIFICATION_LIFETIME_MS } from './activation.rules.js';
import { readinessChecks, readinessState } from './channels-verify.rules.js';
import { selectReadiness, storeReadiness } from './channels-verify.repository.js';

export async function verifyChannel(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; actorId: string },
  channelId: string,
  services: ActivationServices & { newId: () => string },
) {
  const now = services.now();
  return scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
    const row = await selectReadiness(tx, scope.workspaceId, channelId, now);
    if (!row) {
      throw new DomainError('E-NOT-FOUND');
    }
    const connection = {
      credential: await services.secretStore.get(tx, scope.workspaceId, 'bot_token', row.tokenRef),
      providerAccountId: row.providerAccountId,
      webhookUrl:
        services.publicBaseUrl.replace(/\/$/u, '') +
        '/api/v1/webhooks/telegram/' +
        row.connectionId,
    };
    const chat = await services.provider.describeChat(connection, row.providerChatId);
    const checks = readinessChecks(
      await services.provider.checkReadiness(connection, row.providerChatId),
      row.inbound,
    );
    const state = readinessState(checks, row.channelStatus);
    const check = {
      id: services.newId(),
      checkedAt: now,
      expiresAt: new Date(now.getTime() + VERIFICATION_LIFETIME_MS),
      activationReady: state.ready,
      checks,
    };
    await storeReadiness(tx, scope.workspaceId, {
      ...row,
      channelId,
      check,
      chat,
      status: state.status,
      channelStatus: state.channelStatus,
    });
    if (row.monitored && state.channelStatus !== 'active') {
      await cancelChannelNotifications(tx, scope.workspaceId, { channelId, now });
    }
    return check;
  });
}
