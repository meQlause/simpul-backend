import { z as zod } from 'zod';
import { validationError } from '../../platform/errors/validation-error.js';

export const personIdSchema = zod.guid();

const TEAMS = ['Operations', 'Warehouse', 'Sales', 'Finance', 'Other'] as const;

// Telegram usernames: 5–32 letters, digits or underscores. A leading @ is optional and stored.
const handleMessage = 'Use 5–32 letters, numbers or underscores.';
const telegramHandle = zod
  .string()
  .trim()
  .transform((value) => value.replace(/^@/u, ''))
  .pipe(zod.string().regex(/^\w{5,32}$/u))
  .transform((username) => `@${username}`);

export const personPatchSchema = zod
  .strictObject({
    roleName: zod.string().trim().min(1).max(60).optional(),
    managerId: zod.guid().optional(),
    availability: zod.enum(['available', 'leave']).optional(),
    backupPersonId: zod.guid().optional(),
    telegramHandle: telegramHandle.nullable().optional(),
    active: zod.literal(false).optional(),
  })
  .refine((input) => Object.keys(input).length > 0);

export type PersonPatch = zod.infer<typeof personPatchSchema>;

export function parsePersonPatch(input: unknown) {
  const parsed = personPatchSchema.safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error, {
      roleName: 'Enter a role name first.',
      telegramHandle: handleMessage,
    });
  }

  return parsed.data;
}

const newPersonSchema = zod.strictObject({
  name: zod.string().trim().min(1).max(120),
  telegramHandle: telegramHandle.optional(),
  roleName: zod.string().trim().min(1).max(60),
  team: zod.enum(TEAMS),
});

export type NewPerson = zod.infer<typeof newPersonSchema>;

export function parseNewPerson(input: unknown) {
  const parsed = newPersonSchema.safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error, {
      name: 'Enter a name.',
      roleName: 'Enter a role name first.',
      telegramHandle: handleMessage,
    });
  }

  return parsed.data;
}
