import type { ZodError } from 'zod';
import { DomainError } from './domain-error.js';

export function validationError(error: ZodError, messages: Readonly<Record<string, string>> = {}) {
  const details = error.issues.flatMap<{
    field: string;
    issue: 'unknown' | 'invalid';
    message?: string;
  }>((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((field) => ({ field, issue: 'unknown' }));
    }
    const field = issue.path.join('.');
    return [{ field, issue: 'invalid', message: messages[field] }];
  });
  return new DomainError('E-VALIDATION', details);
}
