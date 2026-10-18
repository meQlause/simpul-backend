import { createHash } from 'node:crypto';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordConfigChange } from '../audit/index.js';
import { selectPeople } from './people.repository.js';
import { readyBot, upsertInvite } from './people-invites.repository.js';
import { bareUsername, inviteExpiry, inviteLink } from './people.rules.js';

// FR-TG-12: a fresh link for an active person, through the workspace's ready bot. Only the code's
// hash is stored, and the audit row names the person, never the code.
export async function createInvite(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; actorId: string },
  personId: string,
  input: { now: Date; code: string },
) {
  return scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
    const person = (await selectPeople(tx, scope.workspaceId, personId))[0];
    const bot = await readyBot(tx, scope.workspaceId);

    if (!person || !bot) {
      throw new DomainError('E-NOT-FOUND');
    }

    const expiresAt = new Date(inviteExpiry(input.now));

    await upsertInvite(tx, scope.workspaceId, {
      personId,
      botConnectionId: bot.id,
      codeHash: createHash('sha256').update(input.code).digest(),
      createdAt: input.now,
      expiresAt,
      createdBy: scope.actorId,
    });
    await recordConfigChange(tx, {
      ...scope,
      tableName: 'people',
      recordId: personId,
      before: person,
      after: person,
    });

    return { link: inviteLink(bot.botUsername, input.code), expiresAt: expiresAt.toISOString() };
  });
}

export async function workspaceBotUsername(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
) {
  const bot = await scopedTransaction(resolveConnection, workspaceId, (tx) =>
    readyBot(tx, workspaceId),
  );

  return bot ? bareUsername(bot.botUsername) : null;
}
