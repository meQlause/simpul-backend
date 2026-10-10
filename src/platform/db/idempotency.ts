import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DomainError } from '../errors/domain-error.js';
import type { ConnectionResolver } from './connection-resolver.js';
import { transactionOnClient } from './scoped-transaction.js';

type Request = { workspaceId: string; endpoint: string; key: string; payload: object };
type Operations<Outcome, Result> = {
  prepare: (tx: PoolClient) => Promise<Outcome>;
  complete: (tx: PoolClient, outcome: Outcome) => Promise<Result>;
};

function fingerprint(request: Request) {
  return createHash('sha256').update(JSON.stringify(request.payload)).digest();
}

async function previousRequest<Outcome, Result>(tx: PoolClient, request: Request) {
  const result = await tx.query<{
    fingerprint: Buffer;
    response: Result | null;
    outcome: Outcome | null;
  }>(
    'SELECT fingerprint, response, outcome FROM idempotency_keys WHERE workspace_id = $1 AND endpoint = $2 AND key = $3',
    [request.workspaceId, request.endpoint, request.key],
  );
  const previous = result.rows[0];
  if (previous && !previous.fingerprint.equals(fingerprint(request))) {
    throw new DomainError('E-TG-IDEMPOTENCY-CONFLICT');
  }
  return previous;
}

export async function idempotent<Result>(
  tx: PoolClient,
  request: Request,
  operation: () => Promise<Result>,
) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    JSON.stringify([request.workspaceId, request.endpoint, request.key]),
  ]);
  const previous = await previousRequest<never, Result>(tx, request);
  if (previous) {
    if (previous.response === null) {
      throw new DomainError('E-INTERNAL');
    }
    return previous.response;
  }
  const response = await operation();
  await tx.query(
    'INSERT INTO idempotency_keys (workspace_id, endpoint, key, fingerprint, response) VALUES ($1, $2, $3, $4, $5)',
    [request.workspaceId, request.endpoint, request.key, fingerprint(request), response],
  );
  return response;
}

async function reconcile<Outcome, Result>(
  client: PoolClient,
  request: Request,
  operations: Operations<Outcome, Result>,
) {
  const prepared = await transactionOnClient(client, request.workspaceId, async (tx) => {
    const previous = await previousRequest<Outcome, Result>(tx, request);
    if (previous && previous.response !== null) {
      return { response: previous.response, outcome: null };
    }
    const outcome = previous?.outcome ?? (await operations.prepare(tx));
    await tx.query(
      `INSERT INTO idempotency_keys (workspace_id, endpoint, key, fingerprint, outcome)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT (workspace_id, endpoint, key) DO UPDATE SET outcome = EXCLUDED.outcome`,
      [request.workspaceId, request.endpoint, request.key, fingerprint(request), outcome],
    );
    return { response: null, outcome };
  });
  if (prepared.response !== null) {
    return prepared.response;
  }
  if (prepared.outcome === null) {
    throw new DomainError('E-INTERNAL');
  }
  const outcome = prepared.outcome;
  return transactionOnClient(client, request.workspaceId, async (tx) => {
    const response = await operations.complete(tx, outcome);
    await tx.query(
      'UPDATE idempotency_keys SET response = $4 WHERE workspace_id = $1 AND endpoint = $2 AND key = $3',
      [request.workspaceId, request.endpoint, request.key, response],
    );
    return response;
  });
}

export async function reconciledIdempotent<Outcome, Result>(
  resolveConnection: ConnectionResolver,
  request: Request,
  operations: Operations<Outcome, Result>,
) {
  const pool = await resolveConnection(request.workspaceId);
  const client = await pool.connect();
  const lock = JSON.stringify([request.workspaceId, request.endpoint, request.key]);
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lock]);
    try {
      return await reconcile(client, request, operations);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]);
    }
  } finally {
    client.release();
  }
}
