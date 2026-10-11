import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { provisionAdmin } from '../auth/index.js';
import { createAdminPerson } from '../people/index.js';
import {
  insertWorkspace,
  selectVocabularyVersion,
  incrementVocabularyVersion,
  finishWorkspaceProvision,
  selectMe,
  selectSettings,
  updateSettings,
  type WorkspaceProvision,
} from './workspace.repository.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordConfigChange } from '../audit/index.js';
import type { z as zod } from 'zod';
import type { settingsSchema } from './workspace.schema.js';

const NOT_FOUND = 'E-NOT-FOUND';

export async function createWorkspace(
  resolveConnection: ConnectionResolver,
  provision: WorkspaceProvision,
) {
  await scopedTransaction(resolveConnection, provision.workspaceId, async (tx) => {
    await provisionAdmin(tx, {
      id: provision.authUserId,
      name: provision.input['admin-name'],
      email: provision.input['admin-email'],
      token: provision.token,
      expiresAt: provision.expiresAt,
      now: provision.now,
    });
    await insertWorkspace(tx, provision);
    await createAdminPerson(tx, {
      id: provision.adminId,
      workspaceId: provision.workspaceId,
      name: provision.input['admin-name'],
      email: provision.input['admin-email'],
      authUserId: provision.authUserId,
      now: provision.now,
    });
    await finishWorkspaceProvision(tx, provision.workspaceId, provision.adminId);
    await recordConfigChange(tx, {
      workspaceId: provision.workspaceId,
      actorId: provision.adminId,
      tableName: 'workspaces',
      recordId: provision.workspaceId,
      before: null,
      after: {
        name: provision.input.name,
        timezone: provision.input.timezone,
        adminPersonId: provision.adminId,
      },
    });
  });
}

export async function saveSettings(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; actorId: string },
  input: zod.infer<typeof settingsSchema>,
) {
  return scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
    const row = await selectSettings(tx, scope.workspaceId);

    if (!row) {
      throw new DomainError(NOT_FOUND);
    }

    const { id, ...before } = row;
    const after = { ...before, ...input };

    await updateSettings(tx, scope.workspaceId, input);
    await recordConfigChange(tx, { ...scope, tableName: 'policies', recordId: id, before, after });

    return after;
  });
}

export async function getSettings(resolveConnection: ConnectionResolver, workspaceId: string) {
  return scopedTransaction(resolveConnection, workspaceId, async (tx) => {
    const row = await selectSettings(tx, workspaceId);

    if (!row) {
      throw new DomainError(NOT_FOUND);
    }

    return {
      quietStart: row.quietStart,
      quietEnd: row.quietEnd,
      budgetPerHour: row.budgetPerHour,
      digestTime: row.digestTime,
      holdSeconds: row.holdSeconds,
      timezone: row.timezone,
    };
  });
}

export async function getMe(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; actorId: string },
) {
  return scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
    const row = await selectMe(tx, scope);

    if (!row) {
      throw new DomainError(NOT_FOUND);
    }

    return {
      person: { id: row.person_id, name: row.person_name, roleName: row.role_name },
      workspace: {
        id: row.workspace_id,
        name: row.workspace_name,
        descriptor: row.descriptor,
        timezone: row.timezone,
        onboardingCompletedAt: row.onboarding_completed_at?.toISOString() ?? null,
        counts: { members: row.members, channels: row.channels, activeRules: row.active_rules },
      },
    };
  });
}

export async function getVocabularyVersion(
  ...parameters: Parameters<typeof selectVocabularyVersion>
) {
  return selectVocabularyVersion(...parameters);
}

export async function advanceVocabularyVersion(
  ...parameters: Parameters<typeof incrementVocabularyVersion>
) {
  return incrementVocabularyVersion(...parameters);
}
