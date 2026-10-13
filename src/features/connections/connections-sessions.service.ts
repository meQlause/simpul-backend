import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import type { ConnectionSetup } from './connections-create.service.js';
import {
  insertSession,
  storeReceiveCheck,
  selectSession,
  identifySession,
  consumeSession,
} from './connections-sessions.repository.js';
import { sessionState } from './connections-sessions.rules.js';

const CODE_TTL_MS = 900000;

type Scope = { workspaceId: string; actorId: string };

export async function issueSession(
  resolveConnection: ConnectionResolver,
  scope: Scope,
  input: { connectionId: string; purpose: string },
  services: ConnectionSetup,
) {
  const now = services.now();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  const code = services.newCode();
  const row = await scopedTransaction(resolveConnection, scope.workspaceId, (tx) =>
    insertSession(tx, scope, {
      ...input,
      id: services.newId(),
      codeHash: createHash('sha256').update(code).digest(),
      now,
      expiresAt,
    }),
  );

  if (!row) {
    throw new DomainError('E-NOT-FOUND');
  }

  return {
    id: row.id,
    purpose: input.purpose,
    command: `/simpul_connect ${code}`,
    expiresAt: expiresAt.toISOString(),
    state: 'pending',
  };
}

export async function pollSession(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; sessionId: string },
  now: Date,
) {
  const row = await scopedTransaction(resolveConnection, scope.workspaceId, (tx) =>
    selectSession(tx, scope.workspaceId, scope.sessionId),
  );

  if (!row) {
    throw new DomainError('E-NOT-FOUND');
  }

  const state = sessionState(
    {
      expiresAt: row.expires_at.getTime(),
      consumed: row.consumed_at !== null,
      identified: row.candidate_chat_id !== null,
    },
    now.getTime(),
  );

  return {
    id: row.id,
    state,
    expiresAt: row.expires_at.toISOString(),
    candidate:
      state === 'identified'
        ? {
            providerChatId: row.candidate_chat_id,
            title: row.candidate_title,
            chatType: row.candidate_chat_type,
          }
        : null,
    receivedAt: row.received_at?.toISOString() ?? null,
  };
}

export async function recordCandidate(
  tx: PoolClient,
  scope: { workspaceId: string; connectionId: string },
  event: { code: string; chatId: string; title: string; chatType: string },
  now: Date,
) {
  await identifySession(tx, {
    ...scope,
    ...event,
    codeHash: createHash('sha256').update(event.code).digest(),
    now,
  });
}

export async function consumeCandidate(
  tx: PoolClient,
  workspaceId: string,
  input: { sessionId: string; connectionId: string; now: Date },
) {
  const candidate = await consumeSession(tx, workspaceId, input);

  if (!candidate) {
    throw new DomainError('E-TG-SESSION-EXPIRED');
  }

  return candidate;
}

export async function recordReceiveCheck(
  tx: PoolClient,
  scope: { workspaceId: string; connectionId: string },
  event: { chatId: string; sentAt: number },
  now: Date,
) {
  await storeReceiveCheck(tx, {
    ...scope,
    chatId: event.chatId,
    sentAt: new Date(event.sentAt),
    now,
  });
}
