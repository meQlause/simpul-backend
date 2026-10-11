import type { Pool } from 'pg';
import { createQueue } from '../queue/index.js';
import { createConnectionResolver } from './connection-resolver.js';

type Options = NonNullable<Parameters<typeof createConnectionResolver>[1]> & {
  scheduling?: boolean;
  register: (queue: Awaited<ReturnType<typeof createQueue>>, pool: Pool) => Promise<void>;
  alert: (event: { workspaceId?: string; code: string }) => void;
};
type Registry = { workspace_id: string; connection_version: string };
type Active = { ref: string; stop: () => Promise<void> };
const DISCOVERY_INTERVAL_MS = 60000;
const UNAVAILABLE = 'E-DB-UNAVAILABLE';

async function openQueue(system: Pool, row: Registry, options: Options): Promise<Active> {
  const resolve = createConnectionResolver(system, { ...options, idleMs: 0, maxConnections: 2 });
  let queue: Awaited<ReturnType<typeof createQueue>> | undefined;

  try {
    const pool = await resolve(row.workspace_id);

    queue = await createQueue(pool, options.scheduling, () =>
      options.alert({ workspaceId: row.workspace_id, code: UNAVAILABLE }),
    );
    await options.register(queue, pool);

    return {
      ref: row.connection_version,
      stop: async () => {
        try {
          await queue!.stop();
        } finally {
          await resolve.close(row.workspace_id);
        }
      },
    };
  } catch (error) {
    await queue?.stop().catch(() => {});
    await resolve.close(row.workspace_id);
    throw error;
  }
}

export function ownDatabaseQueues(system: Pool, options: Options) {
  const active = new Map<string, Active>();
  let pending: Promise<void> | undefined;

  const reconcile = async () => {
    const rows = (await system.query<Registry>('SELECT * FROM own_database_workspaces()')).rows;
    const wanted = new Map(rows.map((row) => [row.workspace_id, row.connection_version]));

    await Promise.all(
      [...active].map(async ([workspaceId, current]) => {
        if (wanted.get(workspaceId) !== current.ref) {
          active.delete(workspaceId);
          await current.stop().catch(() => options.alert({ workspaceId, code: UNAVAILABLE }));
        }
      }),
    );
    await Promise.all(
      rows.map(async (row) => {
        if (active.has(row.workspace_id)) {
          return;
        }

        try {
          active.set(row.workspace_id, await openQueue(system, row, options));
        } catch {
          options.alert({ workspaceId: row.workspace_id, code: UNAVAILABLE });
        }
      }),
    );
  };

  const refresh = () => {
    pending ??= reconcile()
      .catch(() => options.alert({ code: UNAVAILABLE }))
      .finally(() => {
        pending = undefined;
      });

    return pending;
  };

  const timer = setInterval(() => {
    void refresh();
  }, DISCOVERY_INTERVAL_MS).unref();

  return {
    refresh,
    stop: async () => {
      clearInterval(timer);
      await pending;
      await Promise.all([...active.values()].map((current) => current.stop()));
      active.clear();
    },
  };
}
