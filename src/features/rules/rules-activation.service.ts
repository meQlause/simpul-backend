import { DomainError } from '../../platform/errors/domain-error.js';
import { activateSelectedRules } from './rules-activation.repository.js';

export async function saveOnboardingRules(...parameters: Parameters<typeof activateSelectedRules>) {
  const before = await activateSelectedRules(...parameters);

  if (!before) {
    throw new DomainError('E-VALIDATION');
  }

  return before;
}
