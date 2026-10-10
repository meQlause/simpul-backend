import type { Pool } from 'pg';

export type ConnectionResolver = (workspaceId: string) => Promise<Pool>;

export function createConnectionResolver(systemPool: Pool): ConnectionResolver {
  return async (_workspaceId) => systemPool;
}
