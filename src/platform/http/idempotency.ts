import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DomainError } from '../errors/domain-error.js';

export async function idempotent<Result>(
  tx: PoolClient,
  request: { workspaceId: string; endpoint: string; key: string; payload: object },
  operation: () => Promise<Result>,
) {
  const { workspaceId, endpoint, key, payload } = request;
  const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest();
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    JSON.stringify([workspaceId, endpoint, key]),
  ]);
  const previous = await tx.query<{ fingerprint: Buffer; response: Result }>(
    'SELECT fingerprint, response FROM idempotency_keys WHERE workspace_id = $1 AND endpoint = $2 AND key = $3',
    [workspaceId, endpoint, key],
  );
  if (previous.rows[0]) {
    if (!previous.rows[0].fingerprint.equals(fingerprint)) {
      throw new DomainError('E-TG-IDEMPOTENCY-CONFLICT');
    }
    return previous.rows[0].response;
  }
  const response = await operation();
  await tx.query(
    'INSERT INTO idempotency_keys (workspace_id, endpoint, key, fingerprint, response) VALUES ($1, $2, $3, $4, $5)',
    [workspaceId, endpoint, key, fingerprint, response],
  );
  return response;
}
