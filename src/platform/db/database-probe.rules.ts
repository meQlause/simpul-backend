export function probeState(
  status: 'connected' | 'unreachable',
  streak: number,
  reachable: boolean,
) {
  if ((status === 'connected') === reachable) {
    return { status, streak: 0, changed: false };
  }

  const next = streak + 1;
  const REQUIRED_PROBES = 2;

  if (next < REQUIRED_PROBES) {
    return { status, streak: next, changed: false };
  }

  return {
    status: reachable ? ('connected' as const) : ('unreachable' as const),
    streak: 0,
    changed: true,
  };
}
