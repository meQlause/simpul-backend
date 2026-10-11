type StoredStatus = 'tentative' | 'active' | 'completed' | 'cancelled' | 'archived';

export function displayStatus(
  thread: { status: StoredStatus; lastActivityAt: number },
  thresholdHours: number,
  now: number,
) {
  const millisecondsPerHour = 3600000;

  return thread.status === 'active' &&
    now - thread.lastActivityAt > thresholdHours * millisecondsPerHour
    ? 'stalled'
    : thread.status;
}
