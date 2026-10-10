import { checksPass } from './activation.rules.js';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordConfigChange } from '../audit/index.js';
import {
  insertDraft,
  selectChannels,
  selectLatestVerification,
  setConnectionNeedsAction,
  selectChannelState,
  storePause,
} from './channels.repository.js';
import type { parseChannel, parsePause } from './channels.schema.js';
import { consumeCandidate } from '../connections/index.js';
import type { PoolClient } from 'pg';
import { cancelChannelNotifications } from '../delivery/index.js';

const NOT_FOUND = 'E-NOT-FOUND';

export async function pauseChannel(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; actorId: string },
  input: ReturnType<typeof parsePause>,
  now: Date,
) {
  return scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
    const before = await selectChannelState(tx, scope.workspaceId, input.channelId);
    if (!before) {
      throw new DomainError(NOT_FOUND);
    }
    if (before.configVersion !== input.expectedConfigVersion) {
      throw new DomainError('E-TG-VERSION-CONFLICT');
    }
    await storePause(tx, scope.workspaceId, input.channelId);
    await cancelChannelNotifications(tx, scope.workspaceId, { channelId: input.channelId, now });
    await recordConfigChange(tx, {
      ...scope,
      tableName: 'channels',
      recordId: input.channelId,
      before: { connectionStatus: before.connectionStatus, monitored: before.monitored },
      after: { connectionStatus: 'paused', monitored: false },
    });
    return (await selectChannels(tx, scope.workspaceId)).find(
      (row: { id: string }) => row.id === input.channelId,
    );
  });
}

export async function markConnectionNeedsAction(
  tx: PoolClient,
  scope: { workspaceId: string; actorId: string },
  connectionId: string,
) {
  const changed = await setConnectionNeedsAction(tx, scope.workspaceId, connectionId);
  for (const row of changed) {
    await recordConfigChange(tx, {
      ...scope,
      tableName: 'channels',
      recordId: row.id,
      before: { monitored: row.monitored, connectionStatus: row.connectionStatus },
      after: { monitored: false, connectionStatus: 'needs_action' },
    });
  }
}

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
      throw new DomainError(NOT_FOUND);
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

export async function getChannel(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
  channelId: string,
) {
  return scopedTransaction(resolveConnection, workspaceId, async (tx) => {
    const channel = (await selectChannels(tx, workspaceId)).find(
      (row: { id: string }) => row.id === channelId,
    );
    if (!channel) {
      throw new DomainError(NOT_FOUND);
    }
    const check = await selectLatestVerification(tx, workspaceId, channelId);
    const verification = check
      ? {
          id: check.id,
          checkedAt: check.checkedAt,
          expiresAt: check.expiresAt,
          checks: check.checks,
          activationReady: check.versionsMatch && checksPass(check.checks),
        }
      : null;
    return { ...channel, verification };
  });
}
