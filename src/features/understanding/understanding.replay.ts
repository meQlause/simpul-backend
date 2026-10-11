import type { PoolClient } from 'pg';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { queryPayload } from './understanding.schema.js';
import { removeModelFailure } from './understanding.repository.js';

export async function replayModelFailure(
  dependencies: {
    resolveConnection: ConnectionResolver;
    publishResolve: (
      tx: PoolClient,
      payload: { workspaceId: string; unitId: string },
    ) => Promise<unknown>;
  },
  payload: { workspaceId: string; unitId: string },
) {
  const scope = queryPayload.parse(payload);

  return scopedTransaction(dependencies.resolveConnection, scope.workspaceId, async (tx) => {
    if (!(await removeModelFailure(tx, scope))) {
      return false;
    }

    await dependencies.publishResolve(tx, scope);

    return true;
  });
}
