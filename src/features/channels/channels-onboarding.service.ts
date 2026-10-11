import { selectActiveVerifiedGroup } from './channels-onboarding.repository.js';

export async function hasActiveVerifiedGroup(
  ...parameters: Parameters<typeof selectActiveVerifiedGroup>
) {
  return selectActiveVerifiedGroup(...parameters);
}
