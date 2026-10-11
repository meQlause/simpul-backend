import { expect, test, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { scopedTransaction } from '../../../../src/platform/db/scoped-transaction.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';

test('The scoped transaction runner takes its pool from the connection resolver and from nowhere else', async () => {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
  const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
  const resolver = vi.fn().mockResolvedValue(pool);
  const operation = vi.fn().mockResolvedValue('result');

  await expect(scopedTransaction(resolver, workspaceId, operation)).resolves.toBe('result');
  expect(resolver).toHaveBeenCalledExactlyOnceWith(workspaceId);
  expect(pool.connect).toHaveBeenCalledExactlyOnceWith();
  expect(operation).toHaveBeenCalledExactlyOnceWith(client);
  expect(client.query.mock.calls).toEqual([
    ['BEGIN'],
    ["SELECT set_config('app.workspace_id', $1, true)", [workspaceId]],
    ['COMMIT'],
  ]);
  expect(client.release).toHaveBeenCalledExactlyOnceWith();
});

test('B1 resolves every workspace to the system pool', async () => {
  const pool = {} as Pool;
  const resolver = createConnectionResolver(pool);

  await expect(resolver(workspaceId)).resolves.toBe(pool);
  await expect(resolver('00000000-0000-4000-8000-000000000002')).resolves.toBe(pool);
});

test('A rejected connection resolution cannot start a workspace operation', async () => {
  const unavailable = new Error('Database unavailable');
  const resolver = vi.fn().mockRejectedValue(unavailable);
  const operation = vi.fn<(tx: PoolClient) => Promise<void>>();

  await expect(scopedTransaction(resolver, workspaceId, operation)).rejects.toBe(unavailable);
  expect(operation).not.toHaveBeenCalled();
});
