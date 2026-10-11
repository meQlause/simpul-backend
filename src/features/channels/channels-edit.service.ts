import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordConfigChange } from '../audit/index.js';
import { cancelChannelNotifications } from '../delivery/index.js';
import { selectChannels } from './channels.repository.js';
import { selectEditableChannel, storeChannelEdit } from './channels-edit.repository.js';
import { channelEditState } from './channels-edit.rules.js';
import type { parseChannelEdit } from './channels-edit.schema.js';

export async function editChannel(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; actorId: string },
  input: ReturnType<typeof parseChannelEdit>,
  now: Date,
) {
  return scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
    const before = await selectEditableChannel(tx, scope.workspaceId, input.channelId);

    if (!before) {
      throw new DomainError('E-NOT-FOUND');
    }

    if (before.configVersion !== input.expectedConfigVersion) {
      throw new DomainError('E-TG-VERSION-CONFLICT');
    }

    const next = {
      displayName: input.displayName ?? before.displayName,
      class: input.class ?? before.class,
      primaryLanguage: input.primaryLanguage ?? before.primaryLanguage,
      configVersion: before.configVersion + 1,
      ...channelEditState(before, input.class),
    };

    await storeChannelEdit(tx, scope.workspaceId, input.channelId, next);

    if (before.monitored && !next.monitored) {
      await cancelChannelNotifications(tx, scope.workspaceId, { channelId: input.channelId, now });
    }

    await recordConfigChange(tx, {
      ...scope,
      tableName: 'channels',
      recordId: input.channelId,
      before,
      after: next,
    });

    return (await selectChannels(tx, scope.workspaceId)).find(
      (channel: { id: string }) => channel.id === input.channelId,
    );
  });
}
