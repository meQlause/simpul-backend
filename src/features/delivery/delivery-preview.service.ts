import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { resolveRoleRecipientInTransaction, findActivePerson } from '../people/index.js';
import { renderNotification } from './delivery.rules.js';
import {
  selectPreviewWork,
  selectPreviewCandidates,
  selectPreviewDigest,
} from './delivery-preview.repository.js';

const voiceNote = {
  transcriptSample: 'Three cases for Mrs. Sri are ready to ship.',
  failureMessage: 'The voice note could not be transcribed. Please type the update in this group.',
};

export async function recipientPreview(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
  now: Date,
) {
  return scopedTransaction(resolveConnection, workspaceId, async (tx) => {
    const sample = await selectPreviewWork(tx, workspaceId, now);
    const digest = await selectPreviewDigest(tx, workspaceId);

    if (!sample) {
      return { notification: null, clarification: null, digest, voiceNote };
    }

    const recipient = await resolveRoleRecipientInTransaction(
      tx,
      workspaceId,
      sample.roleId,
      sample.channelId,
    );
    const person = recipient.personId
      ? await findActivePerson(tx, workspaceId, recipient.personId)
      : null;
    const recipientLabel = labelForRecipient(recipient, person?.name ?? '', sample);

    return {
      notification: {
        recipientLabel,
        work: { displayId: sample.displayId, customer: sample.customer },
        body: renderNotification(sample.template, {
          work_id: sample.displayId,
          customer: sample.customer,
          summary: sample.summary,
        }),
        reminderCount: sample.reminderCount,
        holdSeconds: sample.holdSeconds,
        opId: sample.opId,
        actions: ['completed', 'active', 'stalled'],
      },
      clarification: {
        candidates: await selectPreviewCandidates(tx, workspaceId, sample.channelId, now),
        expiresAfterMinutes: 10,
        perWorkPerDay: 1,
        perChannelPerDay: 3,
      },
      digest,
      voiceNote,
    };
  });
}

function labelForRecipient(
  recipient: Awaited<ReturnType<typeof resolveRoleRecipientInTransaction>>,
  name: string,
  sample: { holderName: string; channelName: string },
) {
  if (recipient.kind === 'channel') {
    return sample.channelName + ' group · No available recipient';
  }

  if (recipient.via === 'backup') {
    return name + ' · Backup for ' + sample.holderName.split(' ')[0];
  }

  if (recipient.via === 'admin') {
    return name + ' · Workspace admin fallback';
  }

  return name;
}
