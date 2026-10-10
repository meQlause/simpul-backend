import { insertAudit } from './audit.repository.js';

export async function recordAudit(...parameters: Parameters<typeof insertAudit>) {
  await insertAudit(...parameters);
}
