import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { createSecretStore } from '../../platform/secrets/index.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { sendMail } from '../../platform/mail/index.js';
import { mailConfiguration } from '../workspace/index.js';
import { recordDigest } from '../audit/index.js';
import {
  dueDigests,
  digestLines,
  finishDigest,
  heldDigestItems,
  moveHeldItems,
} from './delivery-digest.repository.js';
import { pendingDigest, budgetFacts } from './delivery-budget.repository.js';
import type { PoolClient } from 'pg';

type Services = {
  resolveConnection: ConnectionResolver;
  now: () => Date;
  secretStore: ReturnType<typeof createSecretStore>;
  sendMail?: typeof sendMail;
};

export async function runDigests(services: Services, scope: { workspaceId: string }) {
  const now = services.now();

  return scopedTransaction(services.resolveConnection, scope.workspaceId, async (tx) => {
    const mail = await mailConfiguration(tx, scope.workspaceId);

    if (!mail) {
      return;
    }

    const password = await services.secretStore.get(
      tx,
      scope.workspaceId,
      'mail_password',
      mail.passwordSecretRef,
    );

    for (const digest of await dueDigests(tx, scope.workspaceId, now)) {
      await deliverDigest(tx, {
        services,
        workspaceId: scope.workspaceId,
        mail: { ...mail, password },
        now,
        digest,
      });
    }
  });
}

async function deliverDigest(
  tx: PoolClient,
  input: {
    services: Services;
    workspaceId: string;
    mail: NonNullable<Awaited<ReturnType<typeof mailConfiguration>>> & { password: string };
    now: Date;
    digest: Awaited<ReturnType<typeof dueDigests>>[number];
  },
) {
  const { services, workspaceId, mail, now, digest } = input;
  const scope = { workspaceId, digestId: digest.id };
  const lines = await digestLines(tx, scope, now);

  if (!lines.length) {
    return;
  }

  await (services.sendMail ?? sendMail)(
    { host: mail.host, port: mail.port, username: mail.username, password: mail.password },
    {
      from: mail.fromAddress,
      to: digest.email,
      subject: 'Simpul digest',
      text: lines.map((line) => line.text).join('\n'),
      messageId: `<${digest.id}@simpul>`,
    },
  );
  await finishDigest(tx, scope, now);
  await rollOverHeldItems(tx, { ...scope, personId: digest.personId, now });
  await recordDigest(
    tx,
    { workspaceId, personId: digest.personId, now },
    { recipientName: digest.name, count: lines.length },
  );
}

async function rollOverHeldItems(
  tx: PoolClient,
  scope: { workspaceId: string; digestId: string; personId: string; now: Date },
) {
  if (!(await heldDigestItems(tx, scope, scope.now))) {
    return;
  }

  await budgetFacts(tx, scope, scope.now);
  const nextDigestId = await pendingDigest(tx, scope, scope.now);

  await moveHeldItems(tx, scope, { nextDigestId, now: scope.now });
}
