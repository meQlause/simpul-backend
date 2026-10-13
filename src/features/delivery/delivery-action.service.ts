import type { PoolClient } from 'pg';
import type { InboundMessage } from '../../platform/providers/index.js';
import type { ReceiveProvider } from '../../platform/providers/index.js';
import type { publishNotification } from '../../platform/queue/index.js';
import { z as schema } from 'zod';
import { DomainError } from '../../platform/errors/domain-error.js';
import { correctInTransaction } from './delivery-correction.service.js';
import { recipientActionTarget } from './delivery-action.repository.js';
import { recordStatusInTransaction } from './delivery-status.service.js';
import { questionTarget } from './delivery-question.repository.js';
import { questionAnswer } from './delivery.rules.js';

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
  answerQuestion?: (
    tx: PoolClient,
    input: { workspaceId: string; questionId: string; actorId: string; answer: string },
  ) => Promise<unknown>;
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

// A button of a clarification (q:<question>:<choice>) or a plain 1–4 reply while a question is open.
function parseQuestion(event: ActionEvent) {
  if (event.type === 'message') {
    const body = event.body.trim();

    return /^[1-4]$/u.test(body) ? { choice: Number(body) } : undefined;
  }

  const match = /^q:([^:]+):([1-4])$/u.exec(event.actionId);

  return match && schema.guid().safeParse(match[1]).success
    ? { questionId: match[1], choice: Number(match[2]) }
    : undefined;
}

async function questionFor(
  tx: PoolClient,
  scope: { workspaceId: string; connectionId: string; provider: string },
  event: ActionEvent,
  now: Date,
) {
  const parsed = parseQuestion(event);

  if (!parsed) {
    return undefined;
  }

  const target = await questionTarget(
    tx,
    { ...scope, now },
    event,
    'questionId' in parsed ? parsed.questionId : undefined,
  );
  const answer = target ? questionAnswer(parsed.choice, target.threadIds) : undefined;

  return target && answer !== undefined
    ? { questionId: target.questionId, actorId: target.actorId, answer }
    : undefined;
}

async function answerWith(
  tx: PoolClient,
  scope: { workspaceId: string },
  question: { questionId: string; actorId: string; answer: string },
  services: ActionServices,
) {
  if (await services.claimUpdate()) {
    if (!services.answerQuestion) {
      throw new DomainError('E-INTERNAL');
    }

    await services.answerQuestion(tx, { workspaceId: scope.workspaceId, ...question });
  }

  return true;
}

type Target = NonNullable<Awaited<ReturnType<typeof recipientActionTarget>>>;

function appliesTo(action: { code: string }, target: Target | undefined): target is Target {
  return target !== undefined && (target.hasOperation || !['4', 'x'].includes(action.code));
}

export async function receiveRecipientAction(
  tx: PoolClient,
  scope: { workspaceId: string; connectionId: string; provider: string },
  event: ActionEvent,
  services: ActionServices,
) {
  const action = parseAction(event);
  const question = await questionFor(tx, scope, event, services.now);
  const target = action && (await recipientActionTarget(tx, scope, event, action));

  // A reply that could be a status or an answer is neither: the message is stored (D10).
  if (question) {
    return target ? false : answerWith(tx, scope, question, services);
  }

  if (!action || !appliesTo(action, target)) {
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
