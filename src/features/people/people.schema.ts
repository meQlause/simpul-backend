import { z as zod } from 'zod';
import { validationError } from '../../platform/errors/validation-error.js';

export const personIdSchema = zod.guid();

export const personPatchSchema = zod
  .strictObject({
    roleName: zod.string().trim().min(1).max(60).optional(),
    managerId: zod.guid().optional(),
    availability: zod.enum(['available', 'leave']).optional(),
    backupPersonId: zod.guid().optional(),
  })
  .refine((input) => Object.keys(input).length > 0);

export type PersonPatch = zod.infer<typeof personPatchSchema>;

export function parsePersonPatch(input: unknown) {
  const parsed = personPatchSchema.safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error, { roleName: 'Enter a role name first.' });
  }

  return parsed.data;
}
