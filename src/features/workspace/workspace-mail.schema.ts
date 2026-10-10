import { z as zod } from 'zod';
import { validationError } from '../../platform/errors/validation-error.js';

const password = zod.string().min(1).optional();
const mailSchema = zod.strictObject({
  host: zod
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(
      /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/,
    ),
  port: zod.number().int().min(1).max(65535),
  username: zod.string().trim().min(1).max(255),
  password,
  fromAddress: zod.string().trim().pipe(zod.email()),
});

export function parseMail(input: unknown) {
  const parsed = mailSchema.safeParse(input);
  if (!parsed.success) {
    throw validationError(parsed.error);
  }
  return parsed.data;
}

export function requireMailPassword(input: zod.infer<typeof mailSchema>, storedPassword?: string) {
  const parsed = zod
    .string()
    .min(1)
    .safeParse(input.password ?? storedPassword);
  if (!parsed.success) {
    throw validationError(
      new zod.ZodError(parsed.error.issues.map((issue) => ({ ...issue, path: ['password'] }))),
    );
  }
  return parsed.data;
}
