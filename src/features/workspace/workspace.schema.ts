import { z as zod } from 'zod';
import { DomainError } from '../../platform/errors/domain-error.js';

export const createWorkspaceSchema = zod
  .object({
    name: zod.string().trim().min(1).max(80),
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
export const settingsSchema = zod
  .strictObject({
    quietStart: time,
    [QUIET_END]: time,
    budgetPerHour: zod.number().int().min(1).max(50),
    digestTime: time,
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
  const details = parsed.error.issues.flatMap<{ field: string; issue: 'unknown' | 'invalid' }>(
    (issue) => {
      if (issue.code === 'unrecognized_keys') {
        return issue.keys.map((field) => ({ field, issue: 'unknown' as const }));
      }
      return [{ field: issue.path.join('.'), issue: 'invalid' as const }];
    },
  );
  const equal = parsed.error.issues.some((issue) => issue.message === QUIET_HOURS_EQUAL);
  throw new DomainError(equal ? QUIET_HOURS_EQUAL : 'E-VALIDATION', details);
}
