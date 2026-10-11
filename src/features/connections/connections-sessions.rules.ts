export function sessionState(
  session: { expiresAt: number; consumed: boolean; identified: boolean },
  now: number,
) {
  if (session.consumed || session.expiresAt <= now) {
    return 'expired';
  }

  return session.identified ? 'identified' : 'pending';
}
