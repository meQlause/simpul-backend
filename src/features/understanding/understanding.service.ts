import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { PoolClient } from 'pg';
import { DomainError } from '../../platform/errors/domain-error.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import {
  unmatchedQuery,
  insertOrphan,
  lockUnlabelledUnit,
  setLabelCategory,
} from './understanding.repository.js';
import { genesisGate } from './understanding.rules.js';
import { queryPayload, comprehensionScope, comprehensionOutput } from './understanding.schema.js';
import { persistOperation, type OperationOptions } from './understanding-operation.service.js';

export async function recategorizeLabel(
  tx: PoolClient,
  workspaceId: string,
  labelId: string | null,
  categoryId: string,
) {
  if (!labelId || !(await setLabelCategory(tx, workspaceId, labelId, categoryId))) {
    throw new DomainError('E-VALIDATION', [{ field: 'categoryId', issue: 'invalid' }]);
  }
}

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

export async function storeComprehension(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; unitId: string; threadId: string },
  output: unknown,
  options: OperationOptions = {},
) {
  const payload = comprehensionScope.parse(scope);
  const result = comprehensionOutput.parse(output);

  return scopedTransaction(resolveConnection, payload.workspaceId, async (tx) => {
    if (!(await lockUnlabelledUnit(tx, payload))) {
      return;
    }

    for (const operation of result.operations) {
      if (operation.evidenceMessageIds.length === 0) {
        await insertOrphan(tx, payload, 'empty_evidence');
        continue;
      }

      await persistOperation(tx, payload, operation, options);
    }
  });
}
