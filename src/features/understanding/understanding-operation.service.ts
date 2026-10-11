import type { PoolClient } from 'pg';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordProgress, rollback } from '../work/index.js';
import { cancelOperationNotifications } from '../delivery/index.js';
import { insertLabel } from './understanding.repository.js';
import { retireOperation } from './understanding-context.repository.js';

const minimumConfidence = 0.75;

type Scope = { workspaceId: string; unitId: string; threadId: string };
type Operation = Parameters<typeof insertLabel>[2];

export type OperationOptions = {
  now?: Date;
  contextOpIds?: string[];
  publishMatcher?: (
    tx: PoolClient,
    payload: { workspaceId: string; labelId: string },
  ) => Promise<unknown>;
};

export async function persistOperation(
  tx: PoolClient,
  scope: Scope,
  operation: Operation,
  options: OperationOptions,
) {
  validateCorrectionTarget(operation, options);

  const label = await insertLabel(tx, scope, operation, options.now);

  if (!label) {
    return;
  }

  await options.publishMatcher?.(tx, { workspaceId: scope.workspaceId, labelId: label.id });

  if (operation.confidence < minimumConfidence || operation.tense !== 'sudah_terjadi') {
    return;
  }

  if (operation.retractsOpId) {
    await retract(tx, scope, { opId: operation.retractsOpId, now: label.createdAt });
  }

  await recordProgress(tx, scope, {
    opId: label.opId,
    type: operation.type,
    messageId: operation.evidenceMessageIds[0],
    now: label.createdAt,
  });
}

function validateCorrectionTarget(operation: Operation, options: OperationOptions) {
  if (operation.retractsOpId && !options.contextOpIds?.includes(operation.retractsOpId)) {
    throw new DomainError('E-VALIDATION');
  }
}

async function retract(tx: PoolClient, scope: Scope, input: { opId: string; now: Date }) {
  if (!(await retireOperation(tx, scope, input))) {
    throw new DomainError('E-VALIDATION');
  }

  await cancelOperationNotifications(tx, scope.workspaceId, input);
  await rollback(tx, scope, input);
}
