import type { Pool } from 'pg';
import { insertInitialAccount, findSessionPerson, isWorkspaceAdmin } from './auth.repository.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';

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

    if (!person?.person_id) {
      throw new DomainError('E-FORBIDDEN');
    }

    const actorId = person.person_id;
    const allowed = await scopedTransaction(resolveConnection, person.workspace_id, (tx) =>
      isWorkspaceAdmin(tx, actorId),
    );

    if (!allowed) {
      throw new DomainError('E-FORBIDDEN');
    }

    return { workspaceId: person.workspace_id, actorId };
  };
}
