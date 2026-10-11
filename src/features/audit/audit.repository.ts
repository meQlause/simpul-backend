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

export async function insertDecision(
  tx: PoolClient,
  entry: {
    workspaceId: string;
    threadId: string | null;
    recipientPersonId?: string;
    kind: 'work' | 'queue' | 'digest';
    title: string;
    detail: string;
    now: Date;
  },
) {
  await tx.query(
    'INSERT INTO decisions (workspace_id, kind, thread_id, title, detail, occurred_at, recipient_person_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [
      entry.workspaceId,
      entry.kind,
      entry.threadId,
      entry.title,
      entry.detail,
      entry.now,
      entry.recipientPersonId,
    ],
  );
}
