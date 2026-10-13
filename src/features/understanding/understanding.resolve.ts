import type { PoolClient } from 'pg';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { queryPayload, candidatesInput } from './understanding.schema.js';
import { decidedBy, followUpVerdict, quantityCandidates, verdict } from './understanding.rules.js';
import { insertOrphan } from './understanding.repository.js';
import { resolutionFacts } from './understanding.questions.repository.js';
import { recentGenesis, recordResolution } from './understanding-resolution.repository.js';

type Dependencies = {
  resolveConnection: ConnectionResolver;
  publishComprehend: (
    tx: PoolClient,
    payload: { workspaceId: string; unitId: string },
  ) => Promise<unknown>;
};
type Scope = { workspaceId: string; unitId: string };
type Candidate = { id: string; score: number; quantity: number | null; reference?: boolean };
type Verdict = ReturnType<typeof verdict>;

// The verdict is stored before anything else happens (FR-RES-04). A CREATE with recent work in its
// window is a follow-up: it becomes GREY over that work, so the model decides (FR-RES-03, D18).
async function recordVerdict(
  tx: PoolClient,
  payload: Scope,
  input: { scored: Verdict; candidates: Candidate[] },
): Promise<Verdict> {
  const recent = input.scored === 'CREATE' ? await recentGenesis(tx, payload) : [];
  const outcome = followUpVerdict(input.scored, recent);
  const candidates =
    outcome === input.scored
      ? input.candidates.map((candidate) => ({ threadId: candidate.id, score: candidate.score }))
      : recent.map((threadId) => ({
          threadId,
          score: input.candidates.find((candidate) => candidate.id === threadId)?.score ?? 0,
        }));

  await recordResolution(tx, payload, {
    verdict: outcome,
    decidedBy: decidedBy(outcome, input.candidates[0]?.reference ?? false),
    candidates,
    chosenThreadId: outcome === 'ATTACH' ? (input.candidates[0]?.id ?? null) : null,
  });

  return outcome;
}

export async function resolveCandidates(
  dependencies: Dependencies,
  scope: { workspaceId: string; unitId: string },
  input: {
    candidates: readonly Candidate[];
    quantity: number | null;
  },
  _now: Date,
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

    const outcome = await recordVerdict(tx, payload, {
      scored: verdict(
        candidates.map((candidate) => candidate.score),
        facts.thresholds,
      ),
      candidates,
    });

    if (outcome === 'CREATE' && facts.triageClass === 'QUERY') {
      await insertOrphan(tx, payload, 'G1');

      return;
    }

    await dependencies.publishComprehend(tx, payload);
  });
}
