export type Outcome = 'created' | 'attached' | 'held' | 'rejected' | 'ignored' | 'pending';

type Candidate = { displayId: string; summary: string; score: number };

export type MessageFacts = {
  unitId: string;
  occurredAt: string;
  channel: { id: string; name: string };
  senderName: string | null;
  text: string | null;
  outcome: Outcome;
  reason: string | null;
  expiresAt: string | null;
  triageClass: 'EVENT' | 'QUERY' | 'NOISE';
  work: { displayId: string } | null;
  correction: {
    workDisplayId: string;
    action: 'create' | 'attach';
    correctedBy: { name: string | null };
    correctedAt: string;
  } | null;
  resolution: {
    verdict: string;
    decidedBy: string;
    contextMessages: number;
    candidates: Candidate[];
  } | null;
  decisionId: string | null;
};

type Step =
  | { key: 'read'; triageClass: string }
  | {
      key: 'matched';
      verdict: string;
      decidedBy: string;
      contextMessages: number;
      candidates: { displayId: string; summary: string; score: string }[];
    }
  | {
      key: 'outcome';
      status: 'done' | 'held' | 'failed' | 'pending';
      reason: string | null;
      expiresAt: string | null;
    }
  | { key: 'notified'; decisionId: string };

export type MessageRow = Omit<
  MessageFacts,
  'resolution' | 'decisionId' | 'triageClass' | 'expiresAt'
> & {
  steps: Step[];
};

// The step status an outcome shows. An ignored message is done: nothing was meant to happen (D19).
const outcomeStatus: Record<Outcome, 'done' | 'held' | 'failed' | 'pending'> = {
  created: 'done',
  attached: 'done',
  ignored: 'done',
  held: 'held',
  rejected: 'failed',
  pending: 'pending',
};

const MAX_CANDIDATES = 3;

export function scoreText(score: number): string {
  return score.toFixed(2);
}

export function messageRow(facts: MessageFacts): MessageRow {
  const { resolution, decisionId, triageClass, expiresAt, ...rest } = facts;
  const steps: Step[] = [{ key: 'read', triageClass }];

  if (resolution && triageClass !== 'NOISE') {
    steps.push({
      key: 'matched',
      verdict: resolution.verdict,
      decidedBy: resolution.decidedBy,
      contextMessages: resolution.contextMessages,
      candidates: resolution.candidates.slice(0, MAX_CANDIDATES).map((candidate) => ({
        displayId: candidate.displayId,
        summary: candidate.summary,
        score: scoreText(candidate.score),
      })),
    });
  }

  steps.push({
    key: 'outcome',
    status: outcomeStatus[facts.outcome],
    reason: facts.reason,
    expiresAt,
  });

  if (decisionId) {
    steps.push({ key: 'notified', decisionId });
  }

  return { ...rest, steps };
}
