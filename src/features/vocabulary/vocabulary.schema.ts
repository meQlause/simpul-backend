import { z as schema } from 'zod';
import { DomainError } from '../../platform/errors/domain-error.js';
import { validationError } from '../../platform/errors/validation-error.js';

const categorySchema = schema.strictObject({
  name: schema.string().trim().min(1).max(80),
  description: schema.string().trim().min(1).max(300),
  example: schema.string().trim().min(1).max(300),
  idPrefix: schema.string().regex(/^[A-Z]{3}$/u),
});

const aliasSchema = schema.strictObject({
  alias: schema.string().trim().min(1).max(80),
  personId: schema.guid(),
});

export function parseCategory(input: unknown) {
  const parsed = categorySchema.safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return parsed.data;
}

export function parseAlias(input: unknown) {
  const parsed = aliasSchema.safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return parsed.data;
}

export function parseTemplate(input: unknown) {
  const parsed = schema
    .strictObject({ body: schema.string().trim().min(1).max(300) })
    .safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return parsed.data;
}

export function parseCategoryId(input: unknown) {
  const parsed = schema.guid().safeParse(input);

  if (!parsed.success) {
    throw new DomainError('E-NOT-FOUND');
  }

  return parsed.data;
}

export function parseCategoryEdit(input: unknown) {
  const parsed = categorySchema
    .omit({ name: true })
    .partial()
    .refine((value) => Object.keys(value).length > 0)
    .safeParse(input);

  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return parsed.data;
}
