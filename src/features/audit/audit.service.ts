import type { PoolClient } from 'pg';
import { digestDecision, workDecision } from './audit.rules.js';
import { insertAudit, insertDecision } from './audit.repository.js';
import { configAuditSchemas } from './audit.schema.js';

export async function recordConfigChange(...parameters: Parameters<typeof insertAudit>) {
  const [tx, entry] = parameters;
  const snapshot = configAuditSchemas[entry.tableName].nullable();

  await insertAudit(tx, {
    ...entry,
    before: snapshot.parse(entry.before),
    after: snapshot.parse(entry.after),
  });
}

export async function recordDecision(
  tx: PoolClient,
  scope: { workspaceId: string; threadId: string; now: Date },
  facts: Parameters<typeof workDecision>[0] | { kind: 'queue'; title: string; detail: string },
) {
  const decision = 'kind' in facts ? facts : { kind: 'work' as const, ...workDecision(facts) };

  await insertDecision(tx, { ...scope, ...decision });
}

export async function recordDigest(
  tx: PoolClient,
  scope: { workspaceId: string; personId: string; now: Date },
  facts: Parameters<typeof digestDecision>[0],
) {
  await insertDecision(tx, {
    ...scope,
    threadId: null,
    recipientPersonId: scope.personId,
    kind: 'digest',
    ...digestDecision(facts),
  });
}
