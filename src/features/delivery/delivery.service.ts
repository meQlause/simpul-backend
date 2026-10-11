import {
  cancelChannelUnsent,
  cancelWorkUnsent,
  cancelOperationUnsent,
  cancelReminderUnsent,
} from './delivery.repository.js';

export async function cancelOperationNotifications(
  ...parameters: Parameters<typeof cancelOperationUnsent>
) {
  await cancelOperationUnsent(...parameters);
}

export async function cancelChannelNotifications(
  ...parameters: Parameters<typeof cancelChannelUnsent>
) {
  await cancelChannelUnsent(...parameters);
}

export async function cancelWorkNotifications(...parameters: Parameters<typeof cancelWorkUnsent>) {
  await cancelWorkUnsent(...parameters);
}

export async function cancelWorkReminders(...parameters: Parameters<typeof cancelReminderUnsent>) {
  await cancelReminderUnsent(...parameters);
}
