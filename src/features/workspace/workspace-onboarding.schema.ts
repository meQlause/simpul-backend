import { z as zod } from 'zod';
import { validationError } from '../../platform/errors/validation-error.js';

const onboarding = zod
  .strictObject({
    backups: zod.array(zod.strictObject({ roleId: zod.guid(), personId: zod.guid() })),
    activeRuleIds: zod.array(zod.guid()),
  })
  .refine(
    (input) => new Set(input.backups.map((backup) => backup.roleId)).size === input.backups.length,
  )
  .refine((input) => new Set(input.activeRuleIds).size === input.activeRuleIds.length);

export function parseOnboarding(input: unknown) {
  const parsed = onboarding.safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return parsed.data;
}
