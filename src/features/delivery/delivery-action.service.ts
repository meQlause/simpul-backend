import type { PoolClient } from 'pg';
import type { InboundMessage } from '../../platform/providers/index.js';
import type { ReceiveProvider } from '../../platform/providers/index.js';
import type { publishNotification } from '../../platform/queue/index.js';
import { z as schema } from 'zod';
import { DomainError } from '../../platform/errors/domain-error.js';
import { correctInTransaction } from './delivery-correction.service.js';
import { recipientActionTarget } from './delivery-action.repository.js';
import { recordStatusInTransaction } from './delivery-status.service.js';

const STATUS_ACTIONS = {
  '1': 'resolution',
  '2': 'progress',
  '3': 'blocker',
  r: 'resolution',
  p: 'progress',
  b: 'blocker',
} as const;

type ActionEvent =
  InboundMessage | Extract<ReturnType<ReceiveProvider['parse']>, { type: 'action' }>;
type ActionServices = {
  now: Date;
  claimUpdate: () => Promise<boolean>;
  publishNotification?: ReturnType<typeof publishNotification>;
};

function parseAction(event: ActionEvent) {
  if (event.type === 'message') {
    const match = /^([1-4])(?:\s+([A-Z][A-Z0-9]*-\d+))?$/u.exec(event.body.trim());

    return match ? { code: match[1], displayId: match[2], notificationId: undefined } : undefined;
  }

  const match = /^n:([^:]+):([rpbx])$/u.exec(event.actionId);

  return match && schema.guid().safeParse(match[1]).success
    ? { code: match[2], notificationId: match[1], displayId: undefined }
    : undefined;
}

export async function receiveRecipientAction(
  tx: PoolClient,
  scope: { workspaceId: string; connectionId: string; provider: string },
  event: ActionEvent,
  services: ActionServices,
) {
  const action = parseAction(event);

  if (!action) {
    return false;
  }

  const target = await recipientActionTarget(tx, scope, event, action);

  if (!target || (!target.hasOperation && ['4', 'x'].includes(action.code))) {
    return false;
  }

  if (await services.claimUpdate()) {
    await applyAction(
      tx,
      { ...target, workspaceId: scope.workspaceId },
      {
        code: action.code,
        confirmationId: `${scope.connectionId}:${event.updateId}`,
      },
      services,
    );
  }

  return true;
}

async function applyAction(
  tx: PoolClient,
  target: Parameters<typeof correctInTransaction>[1],
  action: { code: string; confirmationId: string },
  services: ActionServices,
) {
  if (action.code !== '4' && action.code !== 'x') {
    await recordStatusInTransaction(
      tx,
      {
        ...target,
        type: STATUS_ACTIONS[action.code as keyof typeof STATUS_ACTIONS],
        confirmationId: action.confirmationId,
      },
      services.now,
    );

    return;
  }

  if (!services.publishNotification) {
    throw new DomainError('E-INTERNAL');
  }

  const notificationId = await correctInTransaction(tx, target, services.now);

  if (notificationId) {
    await services.publishNotification(
      tx,
      { workspaceId: target.workspaceId, notificationId },
      services.now,
    );
  }
}
