import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import { databaseFixture } from '../helpers/database.js';
import { applyMigrations } from '../helpers/migrations.js';
import { seedTenantRows } from '../fixtures/tenant-rows.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000008';

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
});

function insertTemplate(body: string) {
  return pool.query(
    "INSERT INTO templates (workspace_id, key, audience, body) VALUES ($1, $2, 'internal', $3) RETURNING body",
    [workspaceId, randomUUID(), body],
  );
}

test.each(['cost', 'margin', 'internal_note', 'unknown'])(
  'REG-005: A template body containing {{%s}} is refused by templates_placeholders_allowed',
  async (placeholder) => {
    await expect(insertTemplate(`{{work_id}} · {{${placeholder}}}`)).rejects.toMatchObject({
      code: '23514',
      constraint: 'templates_placeholders_allowed',
    });
  },
);

test.each([
  '{{work_id}}',
  '{{customer}}',
  '{{summary}}',
  '{{work_id}} · {{customer}} · {{summary}}',
  'An ordinary update',
])('A template body using only approved placeholders can be stored: %s', async (body) => {
  expect((await insertTemplate(body)).rows).toEqual([{ body }]);
});
