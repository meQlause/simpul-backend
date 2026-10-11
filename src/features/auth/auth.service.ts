import type { Pool } from 'pg';
import { insertInitialAccount, findSessionPerson, isWorkspaceAdmin } from './auth.repository.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { createConnectionResolver } from '../../platform/db/connection-resolver.js';
import { databaseStatus } from '../../platform/db/workspace-databases.repository.js';

const FORBIDDEN = 'E-FORBIDDEN';

export async function provisionAdmin(...parameters: Parameters<typeof insertInitialAccount>) {
  await insertInitialAccount(...parameters);
}

type SessionReader = (headers: Headers) => Promise<{ user: { id: string } } | null>;

export function createAdminResolver(
  readSession: SessionReader,
  pool: Pool,
  resolveConnection: ConnectionResolver,
) {
  return async (headers: Headers) => {
    const session = await readSession(headers);

    if (!session) {
      throw new DomainError('E-AUTH-REQUIRED');
    }

    const person = await findSessionPerson(pool, session.user.id);

    if (!person) {
      throw new DomainError(FORBIDDEN);
    }

    if (!person.person_id) {
      return resolveOwnAdmin(pool, person.workspace_id, session.user.id);
    }

    const actorId = person.person_id;
    const allowed = await scopedTransaction(resolveConnection, person.workspace_id, (tx) =>
      isWorkspaceAdmin(tx, actorId),
    );

    if (!allowed) {
      throw new DomainError(FORBIDDEN);
    }

    return { workspaceId: person.workspace_id, actorId };
  };
}

async function resolveOwnAdmin(pool: Pool, workspaceId: string, authUserId: string) {
  const status = await scopedTransaction(createConnectionResolver(pool), workspaceId, (tx) =>
    databaseStatus(tx, workspaceId),
  );

  if (status !== 'pending') {
    throw new DomainError(FORBIDDEN);
  }

  return { workspaceId, actorId: authUserId, databaseSetupRequired: true };
}
