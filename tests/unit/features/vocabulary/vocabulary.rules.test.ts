import { expect, test } from 'vitest';
import { templateFieldsAllowed } from '../../../../src/features/vocabulary/vocabulary.rules.js';

test.each([
  '{{cost}}',
  '{{margin}}',
  '{{internal_note}}',
  '{{unknown}}',
  '{{cost',
  '{{ work_id }}',
])('Template placeholders must be approved: %s', (body) => {
  expect(templateFieldsAllowed(body)).toBe(false);
});

test.each([
  '{{work_id}}',
  '{{customer}}',
  '{{summary}}',
  '{{work_id}} for {{customer}}: {{summary}}',
  'Ordinary update',
])('Only work_id, customer and summary fields are allowed: %s', (body) => {
  expect(templateFieldsAllowed(body)).toBe(true);
});
