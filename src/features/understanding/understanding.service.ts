import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { unmatchedQuery, insertOrphan } from './understanding.repository.js';
import { genesisGate } from './understanding.rules.js';
import { queryPayload } from './understanding.schema.js';

export async function resolveUnmatchedQuery(
  resolveConnection: ConnectionResolver,
  input: { workspaceId: string; unitId: string },
) {
  const payload = queryPayload.parse(input);

  return scopedTransaction(resolveConnection, payload.workspaceId, async (tx) => {
    if (await unmatchedQuery(tx, payload)) {
      await insertOrphan(tx, payload, genesisGate('status_query')!);
    }
  });
}
