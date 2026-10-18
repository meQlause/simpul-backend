import { createHash } from 'node:crypto';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordConfigChange } from '../audit/index.js';
import { selectPeople } from './people.repository.js';
import type { PoolClient } from 'pg';
import {
  inviteByHash,
  linkInvited,
  linkedPersonId,
  markStarted,
  readyBot,
  upsertInvite,
} from './people-invites.repository.js';
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

// COPY-053, approved 2026-10-17: the bot's reply in the person's private chat.
const START_REPLIES = {
  connected: "You're connected to Simpul. Notifications will arrive here.",
  taken: 'This Telegram account is already connected to someone else. Ask your admin.',
  invalid: 'This link is no longer valid. Ask your admin for a new one.',
  ask_admin: 'Ask your admin for an invite link to connect.',
} as const;

type Start = { senderExternalId: string; senderHandle?: string; codeHash?: string; now: Date };

// FR-TG-12: link on a valid invite, or restart a linked account; the reply says which.
async function startReply(tx: PoolClient, workspaceId: string, start: Start) {
  if (!start.codeHash) {
    return (await markStarted(tx, workspaceId, start.senderExternalId, start.now))
      ? 'connected'
      : 'ask_admin';
  }

  const invite = await inviteByHash(tx, workspaceId, Buffer.from(start.codeHash, 'hex'), start.now);

  if (!invite) {
    return 'invalid';
  }

  const linked = await linkedPersonId(tx, workspaceId, start.senderExternalId);

  if (linked && linked !== invite.personId) {
    return 'taken';
  }

  await linkInvited(tx, workspaceId, {
    personId: invite.personId,
    inviteId: invite.id,
    externalId: start.senderExternalId,
    handle: start.senderHandle ? `@${start.senderHandle}` : null,
    now: start.now,
  });

  return 'connected';
}

// The reply text and the bot that sends it; no bot when the connection is not ready.
export async function answerStart(tx: PoolClient, workspaceId: string, start: Start) {
  const reply = await startReply(tx, workspaceId, start);

  return { text: START_REPLIES[reply], bot: await readyBot(tx, workspaceId) };
}
