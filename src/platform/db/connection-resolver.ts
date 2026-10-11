import type { Pool } from 'pg';
import type { createSecretStore } from '../secrets/index.js';
import { scopedTransaction } from './scoped-transaction.js';
import {
  selectWorkspaceDatabase,
  type WorkspaceDatabase,
} from './workspace-databases.repository.js';
import { openTenantPool, type TenantPoolOptions } from './tenant-pool.js';
import { DomainError } from '../errors/domain-error.js';

export type ConnectionResolver = (workspaceId: string) => Promise<Pool>;

type Options = TenantPoolOptions & { secretStore: ReturnType<typeof createSecretStore> };
const UNAVAILABLE = 'E-DB-UNAVAILABLE';
const RETRY_SECONDS = 60;
const IDLE_MS = 60000;

async function tenantConnection(systemPool: Pool, row: WorkspaceDatabase, options: Options) {
  let pool: Pool | undefined;

  try {
    const url = await scopedTransaction(
      async () => systemPool,
      row.workspace_id,
      (tx) => options.secretStore.get(tx, row.workspace_id, 'database_url', row.url_secret_ref!),
    );

    pool = await openTenantPool(url, options);
    const workspaces = await pool.query<{ id: string }>('SELECT id FROM workspaces');

    if (workspaces.rows.length !== 1 || workspaces.rows[0].id !== row.workspace_id) {
      throw new DomainError(UNAVAILABLE);
    }

    return pool;
  } catch {
    await pool?.end().catch(() => {});
    throw new DomainError(UNAVAILABLE, undefined, RETRY_SECONDS);
  }
}

export function createConnectionResolver(systemPool: Pool, options?: Options) {
  const pools = new Map<string, Promise<Pool>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const close = async (workspaceId: string) => {
    const pending = pools.get(workspaceId);

    pools.delete(workspaceId);
    clearTimeout(timers.get(workspaceId));
    timers.delete(workspaceId);
    await pending?.then(
      (pool) => pool.end(),
      () => {},
    );
  };

  const resolve: ConnectionResolver = async (workspaceId) => {
    const row =
      options &&
      (await scopedTransaction(
        async () => systemPool,
        workspaceId,
        (tx) => selectWorkspaceDatabase(tx, workspaceId),
      ));

    if (!row) {
      return systemPool;
    }

    if (row.status === 'pending') {
      throw new DomainError('E-DB-SETUP-REQUIRED');
    }

    if (row.status !== 'connected') {
      throw new DomainError(UNAVAILABLE, undefined, RETRY_SECONDS);
    }

    return cachedTenantPool(row.workspace_id, () => tenantConnection(systemPool, row, options!), {
      pools,
      timers,
      close,
    });
  };

  return Object.assign(resolve, { close });
}

function cachedTenantPool(
  workspaceId: string,
  open: () => Promise<Pool>,
  cache: {
    pools: Map<string, Promise<Pool>>;
    timers: Map<string, ReturnType<typeof setTimeout>>;
    close: (workspaceId: string) => Promise<void>;
  },
) {
  const { pools, timers, close } = cache;
  let pending = pools.get(workspaceId);

  if (!pending) {
    pending = open();
    pools.set(workspaceId, pending);
    void pending.catch(() => {
      if (pools.get(workspaceId) === pending) {
        pools.delete(workspaceId);
      }
    });
  }

  clearTimeout(timers.get(workspaceId));
  timers.set(
    workspaceId,
    setTimeout(() => {
      void close(workspaceId);
    }, IDLE_MS).unref(),
  );

  return pending;
}
