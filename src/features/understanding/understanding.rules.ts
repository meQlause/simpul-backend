export function verdict(
  scores: readonly number[],
  thresholds: { attach: number; create: number; gap: number },
): 'ATTACH' | 'GREY' | 'CREATE' {
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
