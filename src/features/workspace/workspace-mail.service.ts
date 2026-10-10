import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import type { createSecretStore } from '../../platform/secrets/index.js';
import type { verifyMail } from '../../platform/mail/index.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordAudit } from '../audit/index.js';
import {
  selectMail,
  saveMailRow,
  pendingDigestItems,
  lockMailConfiguration,
} from './workspace-mail.repository.js';
import { mailDto, mailAudit } from './workspace-mail.mapper.js';
import { requireMailPassword, type parseMail } from './workspace-mail.schema.js';

export type MailServices = {
  secretStore: ReturnType<typeof createSecretStore>;
  verifyMail: typeof verifyMail;
  now: () => Date;
};

export async function getMail(resolveConnection: ConnectionResolver, workspaceId: string) {
  return scopedTransaction(resolveConnection, workspaceId, async (tx) => {
    const row = await selectMail(tx, workspaceId);
    return row
      ? { data: mailDto(row) }
      : { data: null, pendingDigestItems: await pendingDigestItems(tx, workspaceId) };
  });
}

export async function saveMail(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; actorId: string },
  input: ReturnType<typeof parseMail>,
  services: MailServices,
) {
  return scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
    await lockMailConfiguration(tx, scope.workspaceId);
    const before = await selectMail(tx, scope.workspaceId);
    const stored =
      before && input.password === undefined
        ? await services.secretStore.get(
            tx,
            scope.workspaceId,
            'mail_password',
            before.passwordSecretRef,
          )
        : undefined;
    const password = requireMailPassword(input, stored);
    try {
      await services.verifyMail({
        host: input.host,
        port: input.port,
        username: input.username,
        password,
      });
    } catch {
      throw new DomainError('E-MAIL-CONNECTION-FAILED');
    }
    const secretRef =
      input.password === undefined && before
        ? before.passwordSecretRef
        : await services.secretStore.put(tx, scope.workspaceId, {
            purpose: 'mail_password',
            value: password,
            id: before?.passwordSecretRef,
          });
    await saveMailRow(tx, scope.workspaceId, { ...input, secretRef, verifiedAt: services.now() });
    const after = await selectMail(tx, scope.workspaceId);
    await recordAudit(tx, {
      ...scope,
      tableName: 'mail_connections',
      recordId: after.id,
      before: mailAudit(before),
      after: mailAudit(after),
    });
    return mailDto(after);
  });
}
