import { z as zod } from 'zod';
import { validationError } from '../../platform/errors/validation-error.js';

const fields = zod.strictObject({
  name: zod.string().trim().min(1).max(100),
  categoryId: zod.guid(),
  eventType: zod.enum(['new', 'progress', 'resolution', 'blocker']),
  conditionText: zod.string().trim().min(1).max(300),
  recipientRoleId: zod.guid(),
  historyMode: zod.enum(['digest', 'future']),
});
const creation = fields.extend({
  historyMode: fields.shape.historyMode.default('digest'),
  reviewItemId: zod.guid().optional(),
});
const patch = fields
  .partial()
  .extend({ active: zod.boolean().optional() })
  .refine((input) => Object.keys(input).length > 0);

export function parseRuleWrite(input: unknown, editing = false) {
  const parsed = (editing ? patch : creation).safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error, {
      name: 'Enter a rule name and condition.',
      conditionText: 'Enter a rule name and condition.',
    });
  }

  return parsed.data;
}

export function parseRuleId(input: unknown) {
  const parsed = zod.guid().safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return parsed.data;
}
