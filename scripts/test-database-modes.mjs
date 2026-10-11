import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

const regressions = readdirSync(new URL('../tests/regression/', import.meta.url))
  .filter((file) => /^REG-(?:00[1-6]|008|009|010)-.*\.test\.ts$/u.test(file))
  .map((file) => `tests/regression/${file}`);

for (const mode of ['hosted', 'own']) {
  process.stdout.write(`\nRegression database mode: ${mode}\n`);
  execFileSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', ...regressions, '--maxWorkers=2'],
    {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, PSPT_TEST_DATABASE_MODE: mode },
      stdio: 'inherit',
    },
  );
}
