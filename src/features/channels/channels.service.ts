import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordConfigChange } from '../audit/index.js';
import { insertDraft } from './channels.repository.js';
import type { parseChannel } from './channels.schema.js';

export async function createChannel(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; actorId: string },
  input: ReturnType<typeof parseChannel>,
  newId: () => string,
) {
  return scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
    const row = await insertDraft(tx, scope.workspaceId, newId(), input);
    if (!row) {
      throw new DomainError('E-NOT-FOUND');
    }
    await recordConfigChange(tx, {
      ...scope,
      tableName: 'channels',
      recordId: row.id,
      before: null,
      after: { ...input, connectionStatus: 'draft', monitored: false },
    });
    return {
      id: row.id,
      displayName: input.displayName,
      providerChatId: input.providerChatId,
      providerChatType: null,
      providerChatTitle: null,
      memberCount: null,
      class: input.class,
      primaryLanguage: input.primaryLanguage,
      connectionStatus: 'draft',
      monitored: false,
      lastVerification: null,
      monitoringStartedAt: null,
      configVersion: 1,
    };
  });
}
