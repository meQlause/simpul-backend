import { expect, test, vi } from 'vitest';
import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import { registerSchedulerJobs } from '../../../src/roles/scheduler.js';

test('SRS §8.5: the scheduler dispatches workspace-scoped silence and digest checks per minute', async () => {
  let tick: (() => Promise<void>) | undefined;
  const queue = {
    schedule: vi.fn(),
    send: vi.fn(),
    work: vi.fn(async (_name: string, callback: () => Promise<void>) => {
      tick = callback;
    }),
  };
  const pool = {
    query: vi.fn(async () => ({ rows: [{ id: 'workspace-a' }, { id: 'workspace-b' }] })),
  };

  await registerSchedulerJobs(queue as unknown as PgBoss, pool as unknown as Pool);
  expect(queue.schedule).toHaveBeenCalledWith('scheduler.tick', '* * * * *');
  await tick?.();
  expect(queue.send.mock.calls).toEqual([
    ['delivery.staleness', { workspaceId: 'workspace-a' }],
    ['delivery.digest', { workspaceId: 'workspace-a' }],
    ['work.lifecycle', { workspaceId: 'workspace-a' }],
    ['delivery.staleness', { workspaceId: 'workspace-b' }],
    ['delivery.digest', { workspaceId: 'workspace-b' }],
    ['work.lifecycle', { workspaceId: 'workspace-b' }],
  ]);
});
