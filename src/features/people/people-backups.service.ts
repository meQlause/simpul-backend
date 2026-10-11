import type { PoolClient } from 'pg';
import { DomainError } from '../../platform/errors/domain-error.js';
import { backupRoster } from './people-backups.repository.js';
import { updateRole } from './people.repository.js';

export async function saveOnboardingBackups(
  tx: PoolClient,
  workspaceId: string,
  backups: { roleId: string; personId: string }[],
) {
  const roster = await backupRoster(tx, workspaceId);

  if (
    backups.some(
      (backup) =>
        !roster.roles.some((role) => role.id === backup.roleId) ||
        !roster.people.includes(backup.personId),
    )
  ) {
    throw new DomainError('E-VALIDATION');
  }

  if (
    roster.roles.some(
      (role) =>
        !backups.some(
          (backup) => backup.roleId === role.id && !role.members.includes(backup.personId),
        ),
    )
  ) {
    throw new DomainError('E-ONBOARDING-BACKUP-MISSING');
  }

  for (const backup of backups) {
    await updateRole(tx, workspaceId, backup.roleId, { backupPersonId: backup.personId });
  }

  return roster.roles.flatMap((role) =>
    role.backups.map((personId) => ({ roleId: role.id, personId })),
  );
}
