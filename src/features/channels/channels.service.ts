import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordConfigChange } from '../audit/index.js';
import { insertDraft, selectChannels } from './channels.repository.js';
import type { parseChannel } from './channels.schema.js';
import { consumeCandidate } from '../connections/index.js';
import type { PoolClient } from 'pg';

export async function listChannels(resolveConnection: ConnectionResolver, workspaceId: string) {
  return scopedTransaction(resolveConnection, workspaceId, (tx) => selectChannels(tx, workspaceId));
}

async function resolveDraft(
  tx: PoolClient,
  workspaceId: string,
  input: ReturnType<typeof parseChannel>,
  now: Date,
) {
  if (input.sessionId) {
    const candidate = await consumeCandidate(tx, workspaceId, {
      sessionId: input.sessionId,
      connectionId: input.botConnectionId,
      now,
    });
    return {
      ...input,
      providerChatId: candidate.chatId,
      providerChatTitle: candidate.title,
      providerChatType: candidate.chatType,
    };
  }
  if (input.providerChatId === undefined) {
    throw new DomainError('E-TG-INPUT-INVALID');
  }
  return {
    ...input,
    providerChatId: input.providerChatId,
    providerChatTitle: null,
    providerChatType: null,
  };
}

export async function createChannel(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; actorId: string },
  input: ReturnType<typeof parseChannel>,
  services: { newId: () => string; now: () => Date },
) {
  return scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
    const draft = await resolveDraft(tx, scope.workspaceId, input, services.now());
    const row = await insertDraft(tx, scope.workspaceId, services.newId(), {
      ...draft,
      providerChatId: draft.providerChatId,
    });
    if (!row) {
      throw new DomainError('E-NOT-FOUND');
    }
    await recordConfigChange(tx, {
      ...scope,
      tableName: 'channels',
      recordId: row.id,
      before: null,
      after: { ...draft, connectionStatus: 'draft', monitored: false },
    });
    return {
      id: row.id,
      displayName: input.displayName,
      providerChatId: draft.providerChatId,
      providerChatType: draft.providerChatType,
      providerChatTitle: draft.providerChatTitle,
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
