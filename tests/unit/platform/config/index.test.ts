import { expect, test } from 'vitest';
import { readConfig } from '../../../../src/platform/config/index.js';

const environment = {
  PROCESS_ROLE: 'api',
  DATABASE_URL: 'postgresql://localhost/simpul',
  DATABASE_MIGRATION_URL: 'postgresql://localhost/simpul',
  DATABASE_QUEUE_URL: 'postgresql://localhost/simpul',
  PUBLIC_BASE_URL: 'https://simpul.example',
  TELEGRAM_API_BASE: 'https://api.telegram.org',
  AUTH_SECRET: 'test-only-auth-secret-with-more-than-32-characters',
  SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  GOOGLE_CLOUD_PROJECT: 'test-project',
};

test('B-6: the four Gemini model ids are pinned in configuration against Google’s current list', () => {
  expect(readConfig(environment)).toMatchObject({
    GEMINI_MODEL_TRIAGE: 'gemini-3.1-flash-lite',
    GEMINI_MODEL_STANDARD: 'gemini-3.8-flash',
    GEMINI_MODEL_STRONG: 'gemini-3.1-pro-preview',
    GEMINI_MODEL_EMBEDDING: 'gemini-embedding-001',
  });
});

test('be-stack §5: model ids remain configurable without changing a feature', () => {
  expect(
    readConfig({ ...environment, GEMINI_MODEL_STANDARD: 'replacement-model' })
      .GEMINI_MODEL_STANDARD,
  ).toBe('replacement-model');
});

test('be-stack §5: every role listens on 3000 unless PORT names another port', () => {
  expect(readConfig(environment).PORT).toBe(3000);
  expect(readConfig({ ...environment, PORT: '3001' }).PORT).toBe(3001);
  expect(() => readConfig({ ...environment, PORT: '0' })).toThrow();
});

test('B-9: models need the Google Cloud project and no API key; the two locations have defaults', () => {
  const withoutProject: Record<string, string | undefined> = { ...environment };

  delete withoutProject.GOOGLE_CLOUD_PROJECT;
  const config = readConfig(environment);

  expect(config).toMatchObject({
    GOOGLE_CLOUD_PROJECT: 'test-project',
    VERTEX_LOCATION: 'global',
    VERTEX_EMBEDDING_LOCATION: 'asia-southeast1',
  });
  expect(config).not.toHaveProperty('GEMINI_API_KEY');
  expect(() => readConfig(withoutProject)).toThrow();
});
