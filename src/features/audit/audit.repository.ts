import type { PoolClient } from 'pg';
import type { configAuditSchemas } from './audit.schema.js';

export type AuditEntry = {
  workspaceId: string;
  actorId: string;
  tableName: keyof typeof configAuditSchemas;
  recordId: string;
  before: object | null;
  after: object | null;
};

export async function insertAudit(tx: PoolClient, entry: AuditEntry) {
  await tx.query(
    `INSERT INTO config_audit (workspace_id, actor_id, table_name, record_id, "before", "after")
    VALUES ($1, $2, $3, $4, $5, $6)`,
    [entry.workspaceId, entry.actorId, entry.tableName, entry.recordId, entry.before, entry.after],
  );
}
