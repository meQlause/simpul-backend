import { sendNotification } from './delivery-send.service.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { detachOperation } from '../understanding/index.js';
import { rollback } from '../work/index.js';
import { recordDecision } from '../audit/index.js';
import { cancelOperationUnsent } from './delivery.repository.js';
import { lockCorrection, storeCorrection } from './delivery-correction.repository.js';
import type { PoolClient } from 'pg';

export async function correctNotification(
  services: Parameters<typeof sendNotification>[0],
  input: { workspaceId: string; notificationId: string; opId: string; actorId: string },
) {
  const notificationId = await scopedTransaction(
    services.resolveConnection,
    input.workspaceId,
    (tx) => correctInTransaction(tx, input, services.now()),
  );

  if (notificationId) {
    await sendNotification(services, { workspaceId: input.workspaceId, notificationId });
  }
}

export async function correctInTransaction(
  tx: PoolClient,
  input: Parameters<typeof correctNotification>[1],
  now: Date,
) {
  const operation = await lockCorrection(tx, input);

  if (!operation) {
    throw new DomainError('E-NOT-FOUND');
  }

  if (operation.personId && operation.personId !== input.actorId) {
    throw new DomainError('E-FORBIDDEN');
  }

  if (operation.correctedAt) {
    return operation.correctionId;
  }

  const scope = { workspaceId: input.workspaceId, threadId: operation.threadId };

  await detachOperation(tx, scope, { opId: input.opId, now });
  await rollback(tx, scope, { opId: input.opId, now });
  await cancelOperationUnsent(tx, input.workspaceId, { opId: input.opId, now });
  const correctionId = await storeCorrection(tx, input, {
    now,
    previousState: operation.previousState,
  });

  await recordDecision(tx, { ...scope, now }, { displayId: operation.displayId, action: 'undo' });

  return correctionId;
}
