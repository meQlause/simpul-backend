export const allowedTemplateFields = ['work_id', 'customer', 'summary'];

export function templateFieldsAllowed(body: string) {
  return !body.replace(/\{\{(?:work_id|customer|summary)\}\}/gu, '').includes('{{');
}

export function formatDisplayId(prefix: string, counter: number) {
  const minimumDigits = 4;

  return prefix + '-' + String(counter).padStart(minimumDigits, '0');
}
