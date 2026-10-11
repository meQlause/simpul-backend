import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { PoolClient } from 'pg';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordProgress } from '../work/index.js';
import { lockCorrection } from './delivery-correction.repository.js';

export async function recordStatus(
  services: { resolveConnection: ConnectionResolver; now: () => Date },
  input: {
    workspaceId: string;
    notificationId: string;
    opId: string;
    actorId: string;
    type: 'progress' | 'resolution' | 'blocker';
    confirmationId: string;
  },
) {
  await scopedTransaction(services.resolveConnection, input.workspaceId, (tx) =>
    recordStatusInTransaction(tx, input, services.now()),
  );
}

export async function recordStatusInTransaction(
  tx: PoolClient,
  input: Parameters<typeof recordStatus>[1],
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
    return;
  }

  await recordProgress(
    tx,
    { workspaceId: input.workspaceId, threadId: operation.threadId },
    {
      opId: input.opId,
      type: input.type,
      messageId: operation.messageId,
      now,
      confirmation: { actorId: input.actorId, id: input.confirmationId },
    },
  );
}
