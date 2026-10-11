const minimumConfidence = 0.75;

export function claimGate(
  label: { tense: string; evidenceMessageIds: readonly string[]; confidence: number },
  thread: { status: string; historical: boolean },
) {
  return (
    label.confidence >= minimumConfidence &&
    label.evidenceMessageIds.length > 0 &&
    label.tense === 'sudah_terjadi' &&
    thread.status === 'active' &&
    !thread.historical
  );
}
