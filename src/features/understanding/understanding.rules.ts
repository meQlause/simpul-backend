type Verdict = 'ATTACH' | 'GREY' | 'CREATE';

export function verdict(
  scores: readonly number[],
  thresholds: { attach: number; create: number; gap: number },
): Verdict {
  const [top = 0, second = 0] = scores.toSorted((left, right) => right - left);

  if (top >= thresholds.attach && top >= second + thresholds.gap) {
    return 'ATTACH';
  }

  return top < thresholds.create ? 'CREATE' : 'GREY';
}

export function groupedScore(
  signals: Record<string, readonly number[]>,
  weights: Record<string, number>,
) {
  return Object.entries(weights).reduce(
    (total, [group, weight]) => total + weight * Math.max(0, ...(signals[group] ?? [])),
    0,
  );
}

export function quantityCandidates<Candidate extends { quantity: number | null }>(
  quantity: number | null,
  candidates: readonly Candidate[],
): readonly Candidate[] {
  return candidates.filter(
    (candidate) =>
      quantity === null || candidate.quantity === null || candidate.quantity === quantity,
  );
}

export function genesisGate(intent: string) {
  return ['status_query', 'ack', 'noise'].includes(intent) ? 'G1' : null;
}

export function injectionSuspected(text: string) {
  return (
    /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions/iu.test(text) ||
    /abaikan\s+(?:semua\s+)?instruksi/iu.test(text) ||
    /(?:system|developer)\s+prompt/iu.test(text)
  );
}

export function decidedBy(outcome: Verdict, topIsReference: boolean) {
  return outcome === 'ATTACH' && topIsReference ? 'reference' : 'score';
}

// A CREATE with recent work in its window is a follow-up until the model says otherwise (FR-RES-03).
export function followUpVerdict(outcome: Verdict, recentThreadIds: readonly string[]) {
  return outcome === 'CREATE' && recentThreadIds.length > 0 ? 'GREY' : outcome;
}

export function greyChoice(
  output: {
    choice: 'candidate' | 'new_work' | 'not_sure';
    threadId: string | null;
    supportingMessageIds: readonly string[];
  },
  supplied: { candidateIds: readonly string[]; messageIds: readonly string[] },
) {
  const supported =
    output.supportingMessageIds.length > 0 &&
    output.supportingMessageIds.every((id) => supplied.messageIds.includes(id));

  if (output.choice === 'not_sure' || !supported) {
    return { kind: 'unsure' as const };
  }

  if (output.choice === 'new_work') {
    return { kind: 'create' as const };
  }

  return output.threadId !== null && supplied.candidateIds.includes(output.threadId)
    ? { kind: 'attach' as const, threadId: output.threadId }
    : { kind: 'unsure' as const };
}
