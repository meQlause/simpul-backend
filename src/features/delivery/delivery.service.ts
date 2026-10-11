import { cancelChannelUnsent, cancelWorkUnsent } from './delivery.repository.js';

export async function cancelChannelNotifications(
  ...parameters: Parameters<typeof cancelChannelUnsent>
) {
  await cancelChannelUnsent(...parameters);
}

export async function cancelWorkNotifications(...parameters: Parameters<typeof cancelWorkUnsent>) {
  await cancelWorkUnsent(...parameters);
}
