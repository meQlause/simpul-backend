import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { PoolClient } from 'pg';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { candidateWork, reopenArchived } from '../work/index.js';
import { runtimeUnit, scoringWeights } from './understanding-runtime.repository.js';
import { rankedCandidates } from './understanding-scoring.rules.js';
import { resolveCandidates } from './understanding.resolve.js';
import { traverseGraph } from './understanding-graph.repository.js';
import { resolutionFacts } from './understanding.questions.repository.js';
import { verdict } from './understanding.rules.js';
import { hasOutcome } from './understanding.repository.js';

type Scope = { workspaceId: string; unitId: string };
type Services = {
  resolveConnection: ConnectionResolver;
  now: () => Date;
  publishComprehend: (
    tx: PoolClient,
    payload: Scope & { threadId: string | null },
  ) => Promise<unknown>;
};

export async function resolveRuntimeUnit(services: Services, scope: Scope) {
  const now = services.now();
  const input = await scopedTransaction(
    services.resolveConnection,
    scope.workspaceId,
    async (tx) => {
      const source = await runtimeUnit(tx, scope);

      if (!source || source.triageClass === 'NOISE' || (await hasOutcome(tx, scope))) {
        return null;
      }

      await reopenArchived(tx, scope.workspaceId, scope.unitId, now);
      const { graphRootIds, ...candidateSource } = source;
      const graph = await traverseGraph(tx, scope.workspaceId, graphRootIds);
      const ranked = rankedCandidates(
        await candidateWork(
          tx,
          scope.workspaceId,
          {
            ...candidateSource,
            graphThreadIds: graph.filter((node) => node.type === 'Thread').map((node) => node.id),
          },
          now,
        ),
        source,
        await scoringWeights(tx, scope.workspaceId),
        now.getTime(),
      );
      const facts = await resolutionFacts(tx, scope);

      return facts
        ? {
            ...ranked,
            outcome: verdict(
              ranked.candidates.map((candidate) => candidate.score),
              facts.thresholds,
            ),
          }
        : null;
    },
  );

  if (!input) {
    return;
  }

  await resolveCandidates(
    {
      ...services,
      publishComprehend: (tx, payload) =>
        services.publishComprehend(tx, {
          ...payload,
          threadId: input.outcome === 'ATTACH' ? input.candidates[0].id : null,
        }),
    },
    scope,
    { quantity: input.quantity, candidates: [...input.candidates] },
    now,
  );
}
