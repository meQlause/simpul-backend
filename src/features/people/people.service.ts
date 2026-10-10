import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordAudit } from '../audit/index.js';
import {
  lockPerson,
  selectPeople,
  selectActiveIds,
  updatePerson,
  updateRole,
  selectRecipientCandidates,
} from './people.repository.js';
import { resolveRecipient, invalidPatchFields } from './people.rules.js';
import type { PersonPatch } from './people.schema.js';

export async function listPeople(resolveConnection: ConnectionResolver, workspaceId: string) {
  return scopedTransaction(resolveConnection, workspaceId, (tx) => selectPeople(tx, workspaceId));
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
    const references = [input.managerId, input.backupPersonId].filter((id) => id !== undefined);
    const activeIds = await selectActiveIds(tx, scope.workspaceId, references);
    const invalid = invalidPatchFields(personId, before.role !== null, input, activeIds);
    if (invalid.length) {
      throw new DomainError(
        'E-VALIDATION',
        [...new Set(invalid)].map((field) => ({ field, issue: 'invalid' })),
      );
    }
    await updatePerson(tx, scope.workspaceId, personId, input);
    if (before.role) {
      await updateRole(tx, scope.workspaceId, before.role.id, input);
    }
    const after = (await selectPeople(tx, scope.workspaceId, personId))[0];
    await recordAudit(tx, { ...scope, tableName: 'people', recordId: personId, before, after });
    return after;
  });
}

export async function resolveRoleRecipient(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
  roleId: string,
  originChannelId: string,
) {
  return scopedTransaction(resolveConnection, workspaceId, async (tx) =>
    resolveRecipient(await selectRecipientCandidates(tx, workspaceId, roleId), originChannelId),
  );
}
