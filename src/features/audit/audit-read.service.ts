import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { decisionCounts, selectDecisions, selectDecision } from './audit-read.repository.js';
import { encodeDecisionCursor, type parseDecisionQuery } from './audit-read.schema.js';

export function listDecisions(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
  input: ReturnType<typeof parseDecisionQuery>,
) {
  return scopedTransaction(resolveConnection, workspaceId, async (tx) => {
    const result = await selectDecisions(tx, workspaceId, input);
    const data = result.rows.slice(0, input.limit);

    return {
      data,
      page: {
        total: result.total,
        nextCursor:
          result.rows.length > input.limit
            ? encodeDecisionCursor(data[data.length - 1], input)
            : null,
      },
      counts: await decisionCounts(tx, workspaceId),
    };
  });
}

export function getDecision(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
  id: string,
) {
  return scopedTransaction(resolveConnection, workspaceId, async (tx) => {
    const result = await selectDecision(tx, workspaceId, id);

    if (!result) {
      throw new DomainError('E-NOT-FOUND');
    }

    return result;
  });
}
