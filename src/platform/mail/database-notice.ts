export function databaseNotice(input: {
  workspaceId: string;
  workspaceName: string;
  host: string;
  email: string;
  status: 'connected' | 'unreachable' | 'migration_failed';
  time: string;
}) {
  const { workspaceId, workspaceName, host, email, status, time } = input;
  const recovered = status === 'connected';

  return {
    to: email,
    subject: recovered
      ? 'Simpul can reach your database again'
      : 'Simpul cannot reach your database',
    text: recovered
      ? `The database for ${workspaceName} at ${host} is reachable again as of ${time}. Messages are being recorded.`
      : `Simpul has not been able to reach the database for ${workspaceName} at ${host} since ${time}. New messages are not being recorded until it is back. Messages older than 24 hours when it returns are lost.`,
    messageId: `<database-${workspaceId}-${status}-${time.replace(/\D/gu, '')}@simpul.local>`,
  };
}
