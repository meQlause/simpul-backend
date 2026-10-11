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

export function genesisState(confidence: number, now: number) {
  const activeThreshold = 0.8;
  const tentativeThreshold = 0.55;
  const tentativeLifetime = 86_400_000;

  if (confidence < tentativeThreshold) {
    return null;
  }

  return confidence >= activeThreshold
    ? { status: 'active', expiresAt: null }
    : { status: 'tentative', expiresAt: now + tentativeLifetime };
}

export function closureStatus(kind: string) {
  return kind === 'completed' ? 'completed' : 'cancelled';
}

export function undoAvailable(item: {
  status: string;
  closedBy: string | null;
  closedAt: number | null;
  lastActivityAt: number;
}) {
  return (
    (item.status === 'completed' || item.status === 'cancelled') &&
    item.closedBy !== null &&
    item.closedAt !== null &&
    item.lastActivityAt <= item.closedAt
  );
}

export function csvRow(cells: (string | null)[]) {
  return (
    cells
      .map((cell) => {
        const value = cell ?? '';
        const safe = /^[=+@-]/u.test(value) ? "'" + value : value;

        return '"' + safe.replaceAll('"', '""') + '"';
      })
      .join(',') + '\r\n'
  );
}
