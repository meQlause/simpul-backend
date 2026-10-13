import type { PoolClient } from 'pg';
import { DomainError } from '../../platform/errors/domain-error.js';
import { answerQuestion } from './understanding.questions.repository.js';
import { settleResolution } from './understanding-resolution.repository.js';

type Services = {
  now: Date;
  publishComprehend?: (
    tx: PoolClient,
    payload: { workspaceId: string; unitId: string; threadId: string | null },
  ) => Promise<unknown>;
};

// A reply in the group picks one of the candidates, or 'none' (FR-RES-02, §8.4).
export async function answerClarification(
  tx: PoolClient,
  input: { workspaceId: string; questionId: string; actorId: string; answer: string },
  services: Services,
) {
  const unitId = await answerQuestion(tx, input, services.now);

  if (!unitId) {
    return false;
  }

  if (input.answer === 'none') {
    return true;
  }

  await settleResolution(
    tx,
    { workspaceId: input.workspaceId, unitId },
    { chosenThreadId: input.answer },
  );

  if (!services.publishComprehend) {
    throw new DomainError('E-INTERNAL');
  }

  await services.publishComprehend(tx, {
    workspaceId: input.workspaceId,
    unitId,
    threadId: input.answer,
  });

  return true;
}
