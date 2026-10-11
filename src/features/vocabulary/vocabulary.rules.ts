export const allowedTemplateFields = ['work_id', 'customer', 'summary'];

export function templateFieldsAllowed(body: string) {
  return !body.replace(/\{\{(?:work_id|customer|summary)\}\}/gu, '').includes('{{');
}
