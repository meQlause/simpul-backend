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
  return async (headers: Headers, databaseSetup = false) => {
    const session = await readSession(headers);

    if (!session) {
      throw new DomainError('E-AUTH-REQUIRED');
    }

    const person = await findSessionPerson(pool, session.user.id);

    if (!person) {
      throw new DomainError(FORBIDDEN);
    }

    if (!person.person_id) {
      return resolveOwnAdmin(
        { pool, resolveConnection, databaseSetup },
        person.workspace_id,
        session.user.id,
      );
    }

    return authorizeAdmin(resolveConnection, person.workspace_id, person.person_id);
  };
}

async function resolveOwnAdmin(
  context: { pool: Pool; resolveConnection: ConnectionResolver; databaseSetup: boolean },
  workspaceId: string,
  authUserId: string,
) {
  const status = await scopedTransaction(
    createConnectionResolver(context.pool),
    workspaceId,
    (tx) => databaseStatus(tx, workspaceId),
  );

  if (!status) {
    throw new DomainError(FORBIDDEN);
  }

  if (status === 'pending' || context.databaseSetup) {
    return { workspaceId, actorId: authUserId, databaseSetupRequired: status === 'pending' };
  }

  const person = await scopedTransaction(context.resolveConnection, workspaceId, (tx) =>
    findSessionPerson(tx, authUserId),
  );

  if (!person?.person_id || person.workspace_id !== workspaceId) {
    throw new DomainError(FORBIDDEN);
  }

  return authorizeAdmin(context.resolveConnection, workspaceId, person.person_id);
}

async function authorizeAdmin(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
  actorId: string,
) {
  const allowed = await scopedTransaction(resolveConnection, workspaceId, (tx) =>
    isWorkspaceAdmin(tx, actorId),
  );

  if (!allowed) {
    throw new DomainError(FORBIDDEN);
  }

  return { workspaceId, actorId };
}
