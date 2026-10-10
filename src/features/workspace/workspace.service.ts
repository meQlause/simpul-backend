import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { provisionAdmin } from '../auth/index.js';
import {
  insertWorkspace,
  selectMe,
  selectSettings,
  updateSettings,
  type WorkspaceProvision,
} from './workspace.repository.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordAudit } from '../audit/index.js';
import type { z as zod } from 'zod';
import type { settingsSchema } from './workspace.schema.js';

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
      throw new DomainError('E-NOT-FOUND');
    }
    const { id, ...before } = row;
    const after = { ...before, ...input };
    await updateSettings(tx, scope.workspaceId, input);
    await recordAudit(tx, { ...scope, tableName: 'policies', recordId: id, before, after });
    return after;
  });
}

export async function getMe(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; actorId: string },
) {
  return scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
    const row = await selectMe(tx, scope);
    if (!row) {
      throw new DomainError('E-NOT-FOUND');
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
