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

export function quantityCandidates<Candidate extends { quantity: number | null }>(
  quantity: number | null,
  candidates: readonly Candidate[],
): readonly Candidate[] {
  return candidates.filter(
    (candidate) =>
      quantity === null || candidate.quantity === null || candidate.quantity === quantity,
  );
}
