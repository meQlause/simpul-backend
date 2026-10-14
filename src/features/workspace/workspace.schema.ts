import { z as zod } from 'zod';
import { DomainError } from '../../platform/errors/domain-error.js';
import { validationError } from '../../platform/errors/validation-error.js';

export const createWorkspaceSchema = zod
  .object({
    name: zod.string().trim().min(1).max(80),
    database: zod.enum(['hosted', 'own']).optional(),
    'admin-name': zod.string().trim().min(1).max(120),
    'admin-email': zod.string().trim().toLowerCase().pipe(zod.email()),
    timezone: zod
      .string()
      .trim()
      .min(1)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: zone });

          return true;
        } catch {
          return false;
        }
      }),
  })
  .strict();

const time = zod.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const QUIET_END = 'quietEnd';
const QUIET_HOURS_EQUAL = 'E-SETTINGS-QUIET-HOURS-EQUAL';

export function parseOverviewQuery(input: unknown) {
  const parsed = zod
    .strictObject({ period: zod.enum(['today', 'week']).default('today') })
    .safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return parsed.data;
}

export const settingsSchema = zod
  .strictObject({
    quietStart: time,
    [QUIET_END]: time,
    budgetPerHour: zod.number().int().min(1).max(50),
    digestTime: time,
    contextWindowMinutes: zod.number().int().min(0).max(180).optional(),
    contextMaxMessages: zod.number().int().min(1).max(30).optional(),
    messageTextAccess: zod.boolean().optional(),
  })
  .refine((input) => input.quietStart !== input.quietEnd, {
    path: [QUIET_END],
    message: QUIET_HOURS_EQUAL,
  });

export function parseSettings(input: unknown) {
  const parsed = settingsSchema.safeParse(input);

  if (parsed.success) {
    return parsed.data;
  }

  const failure = validationError(parsed.error);
  const equal = parsed.error.issues.some((issue) => issue.message === QUIET_HOURS_EQUAL);

  throw equal ? new DomainError(QUIET_HOURS_EQUAL, failure.details) : failure;
}
