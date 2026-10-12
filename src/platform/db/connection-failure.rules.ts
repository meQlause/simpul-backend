export function connectionFailed(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = 'code' in error ? String(error.code) : '';

  return (
    /^(?:08\w{3}|57P0[123]|ECONN(?:REFUSED|RESET|ABORTED)|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH)$/u.test(
      code,
    ) ||
    /^(?:Connection terminated|timeout exceeded when trying to connect|Query read timeout)/u.test(
      error.message,
    )
  );
}

export function rlsRejected(error: unknown) {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '42501' &&
    'routine' in error &&
    error.routine === 'ExecWithCheckOptions'
  );
}
