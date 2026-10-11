import type { selectMail } from './workspace-mail.repository.js';

export function mailDto(row: Awaited<ReturnType<typeof selectMail>>) {
  if (!row) {
    return null;
  }

  return {
    host: row.host,
    port: row.port,
    username: row.username,
    fromAddress: row.fromAddress,
    passwordPresent: true,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
  };
}

export function mailAudit(row: Awaited<ReturnType<typeof selectMail>>) {
  if (!row) {
    return null;
  }

  return { host: row.host, port: row.port, username: row.username, fromAddress: row.fromAddress };
}
