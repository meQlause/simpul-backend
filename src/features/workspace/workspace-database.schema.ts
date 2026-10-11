import { z as zod } from 'zod';
import { validationError } from '../../platform/errors/validation-error.js';

const connectionString = zod
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) {
      return false;
    }

    const url = new URL(value);

    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      Boolean(url.hostname && url.username && url.password && url.pathname.length > 1)
    );
  });

const initialConnection = zod.strictObject({
  connectionString,
  availabilityAck: zod.literal(true),
});
const replacementConnection = zod.strictObject({ connectionString });

export function parseDatabaseConnection(input: unknown, pending: boolean) {
  const result = (pending ? initialConnection : replacementConnection).safeParse(input);

  if (!result.success) {
    throw validationError(result.error);
  }

  return result.data;
}
