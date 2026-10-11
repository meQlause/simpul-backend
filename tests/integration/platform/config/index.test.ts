import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

test('Removing DATABASE_URL fails at boot with a named error, not on first request', () => {
  const environment = { ...process.env };

  delete environment.DATABASE_URL;
  const result = spawnSync(process.execPath, ['dist/server.js'], {
    env: environment,
    encoding: 'utf8',
    timeout: 2000,
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ConfigurationError');
  expect(result.stderr).toContain('DATABASE_URL');
});
