import { cancelChannelUnsent } from './delivery.repository.js';

export async function cancelChannelNotifications(
  ...parameters: Parameters<typeof cancelChannelUnsent>
) {
  await cancelChannelUnsent(...parameters);
}
