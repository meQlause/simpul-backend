import { insertAudit } from './audit.repository.js';
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
