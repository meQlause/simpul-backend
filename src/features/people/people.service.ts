import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { selectReminderRecipient } from './people.repository.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordConfigChange } from '../audit/index.js';
import {
  deactivatePerson,
  handleTaken,
  insertAdminPerson,
  insertPerson,
  linkSenderIdentity,
  lockPerson,
  replaceIdentity,
  selectAdminPersonId,
  selectPeople,
  selectActiveIds,
  updatePerson,
  updateRole,
  selectRecipientCandidates,
} from './people.repository.js';
import { resolveRecipient, invalidPatchFields } from './people.rules.js';
import type { NewPerson, PersonPatch } from './people.schema.js';

export async function reminderRecipient(...args: Parameters<typeof selectReminderRecipient>) {
  return selectReminderRecipient(...args);
}

export async function createAdminPerson(...parameters: Parameters<typeof insertAdminPerson>) {
  await insertAdminPerson(...parameters);
}

export async function listPeople(resolveConnection: ConnectionResolver, workspaceId: string) {
  return scopedTransaction(resolveConnection, workspaceId, (tx) => selectPeople(tx, workspaceId));
}

export async function createPerson(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; actorId: string },
  input: NewPerson,
) {
  return scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
    const handle = input.telegramHandle ?? null;

    if (handle && (await handleTaken(tx, scope.workspaceId, handle, null))) {
      throw new DomainError('E-VALIDATION', [{ field: 'telegramHandle', issue: 'duplicate' }]);
    }

    const id = randomUUID();

    await insertPerson(tx, scope.workspaceId, {
      id,
      name: input.name,
      roleName: input.roleName,
      team: input.team,
      handle,
    });

    const after = (await selectPeople(tx, scope.workspaceId, id))[0];

    await recordConfigChange(tx, {
      ...scope,
      tableName: 'people',
      recordId: id,
      before: null,
      after,
    });

    return after;
  });
}

export async function patchPerson(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; actorId: string },
  personId: string,
  input: PersonPatch,
) {
  return scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
    await lockPerson(tx, scope.workspaceId, personId);
    const before = (await selectPeople(tx, scope.workspaceId, personId))[0];

    if (!before) {
      throw new DomainError('E-NOT-FOUND');
    }

    await refusePatch(tx, {
      workspaceId: scope.workspaceId,
      personId,
      hasRole: before.role !== null,
      input,
    });
    await updatePerson(tx, scope.workspaceId, personId, input);

    if (before.role) {
      await updateRole(tx, scope.workspaceId, before.role.id, input);
    }

    await syncIdentity(tx, {
      workspaceId: scope.workspaceId,
      personId,
      currentHandle: before.identities.find((identity) => identity.provider === 'telegram')?.handle,
      handle: input.telegramHandle,
    });

    const after = (await selectPeople(tx, scope.workspaceId, personId))[0];

    if (input.active === false) {
      await deactivatePerson(tx, scope.workspaceId, personId);
    }

    await recordConfigChange(tx, {
      ...scope,
      tableName: 'people',
      recordId: personId,
      before,
      after,
    });

    return after;
  });
}

async function refusePatch(
  tx: PoolClient,
  {
    workspaceId,
    personId,
    hasRole,
    input,
  }: { workspaceId: string; personId: string; hasRole: boolean; input: PersonPatch },
) {
  const references = [input.managerId, input.backupPersonId].filter((id) => id !== undefined);
  const activeIds = await selectActiveIds(tx, workspaceId, references);
  const isAdmin =
    input.active === false && (await selectAdminPersonId(tx, workspaceId)) === personId;
  const invalid = [
    ...invalidPatchFields(personId, hasRole, input, activeIds),
    ...(isAdmin ? ['active'] : []),
  ];
  const taken =
    input.telegramHandle && (await handleTaken(tx, workspaceId, input.telegramHandle, personId));
  const details = [
    ...[...new Set(invalid)].map((field) => ({ field, issue: 'invalid' as const })),
    ...(taken ? [{ field: 'telegramHandle', issue: 'duplicate' as const }] : []),
  ];

  if (details.length) {
    throw new DomainError('E-VALIDATION', details);
  }
}

// The same username in another letter case keeps the Telegram id the sender was linked by.
async function syncIdentity(
  tx: PoolClient,
  {
    workspaceId,
    personId,
    currentHandle,
    handle,
  }: {
    workspaceId: string;
    personId: string;
    currentHandle?: string | null;
    handle?: string | null;
  },
) {
  if (handle !== undefined && handle?.toLowerCase() !== currentHandle?.toLowerCase()) {
    await replaceIdentity(tx, workspaceId, personId, handle);
  }
}

export async function linkTelegramSender(
  tx: PoolClient,
  input: { workspaceId: string; provider: string; senderExternalId: string; senderHandle: string },
) {
  await linkSenderIdentity(tx, input);
}

export async function resolveRoleRecipient(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
  roleId: string,
  originChannelId: string,
) {
  return scopedTransaction(resolveConnection, workspaceId, async (tx) =>
    resolveRoleRecipientInTransaction(tx, workspaceId, roleId, originChannelId),
  );
}

export async function resolveRoleRecipientInTransaction(
  tx: PoolClient,
  workspaceId: string,
  roleId: string | null,
  originChannelId: string,
) {
  return resolveRecipient(
    await selectRecipientCandidates(tx, workspaceId, roleId),
    originChannelId,
  );
}

export async function findActivePerson(...parameters: Parameters<typeof selectPeople>) {
  return (await selectPeople(...parameters))[0] ?? null;
}
