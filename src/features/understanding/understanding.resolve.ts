import type { PoolClient } from 'pg';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { queryPayload, candidatesInput } from './understanding.schema.js';
import { quantityCandidates, verdict } from './understanding.rules.js';
import { insertOrphan } from './understanding.repository.js';
import { resolutionFacts, askQuestion } from './understanding.questions.repository.js';

type Dependencies = {
  resolveConnection: ConnectionResolver;
  publishComprehend: (
    tx: PoolClient,
    payload: { workspaceId: string; unitId: string },
  ) => Promise<unknown>;
};

export async function resolveCandidates(
  dependencies: Dependencies,
  scope: { workspaceId: string; unitId: string },
  input: {
    candidates: readonly { id: string; score: number; quantity: number | null }[];
    quantity: number | null;
  },
  now: Date,
) {
  const payload = queryPayload.parse(scope);
  const parsed = candidatesInput.parse(input);
  const candidates = quantityCandidates(parsed.quantity, parsed.candidates).toSorted(
    (left, right) => right.score - left.score,
  );

  return scopedTransaction(dependencies.resolveConnection, payload.workspaceId, async (tx) => {
    const facts = await resolutionFacts(tx, payload);

    if (!facts) {
      return;
    }

    const outcome = verdict(
      candidates.map((candidate) => candidate.score),
      facts.thresholds,
    );

    if (outcome === 'GREY') {
      await askQuestion(
        tx,
        { ...payload, channelId: facts.channelId },
        candidates.map((candidate) => candidate.id),
        now,
      );

      return;
    }

    if (outcome === 'CREATE' && facts.triageClass === 'QUERY') {
      await insertOrphan(tx, payload, 'G1');

      return;
    }

    await dependencies.publishComprehend(tx, payload);
  });
}
