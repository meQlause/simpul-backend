import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';
import { inspectImports } from '../../helpers/architecture.js';

test.each([
  ['I-2', 'src/features/work/work.rules.ts', "import { eq } from 'drizzle-orm';"],
  ['I-2', 'src/features/work/work.rules.ts', "import type { Pool } from 'pg';"],
  [
    'I-2',
    'src/features/work/work.rules.ts',
    "import { clock } from '../../platform/clock/index.js';",
  ],
  [
    'I-3',
    'src/features/work/work.service.ts',
    "import { repository } from '../people/people.repository.js';",
  ],
  ['I-4', 'src/features/work/index.ts', "export { repository } from './work.repository.js';"],
  [
    'I-4',
    'src/features/work/index.ts',
    "import { repository } from './work.repository.js'; export { repository };",
  ],
  ['I-5', 'src/platform/http/index.ts', "import { service } from '../../features/work/index.js';"],
  [
    'I-6',
    'src/features/work/work.service.ts',
    "import { model } from '../../platform/llm/index.js';",
  ],
  ['I-6', 'src/features/triage/triage.service.ts', "import { people } from '../people/index.js';"],
  [
    'I-6',
    'src/features/comprehension/comprehension.service.ts',
    "import { templates } from '../vocabulary/templates/index.js';",
  ],
  ['I-7', 'src/features/work/work.service.ts', "import { eq } from 'drizzle-orm';"],
  [
    'I-8',
    'src/features/channels/channels.service.ts',
    "fetch('https://api.telegram.org/bot/secret');",
  ],
  [
    'I-9',
    'src/features/channels/channels.service.ts',
    "import { adapter } from '../../platform/providers/telegram/index.js';",
  ],
  [
    'I-10',
    'src/platform/providers/telegram/index.ts',
    "import { service } from '../../../features/work/index.js';",
  ],
  [
    'I-10',
    'src/platform/providers/telegram/index.ts',
    "import { adapter } from '../other/index.js';",
  ],
  [
    'I-9',
    'src/features/connections/connections.service.ts',
    "import type { ProviderAdapter } from '../../platform/providers/contract.js';",
  ],
  [
    'I-9',
    'src/features/connections/connections.service.ts',
    "const provider = import('../../platform/providers/telegram/index.js');",
  ],
  [
    'I-10',
    'src/platform/providers/fake/receive/message.ts',
    "const feature = import('../../../../features/channels/index.js');",
  ],
  [
    'I-11',
    'src/features/work/work.repository.ts',
    "import { Pool as PgPool } from 'pg'; new PgPool();",
  ],
  ['I-11', 'src/server.ts', "import pg from 'pg'; new pg.Client();"],
])('%s rejects the forbidden import in %s', (rule, path, source) => {
  expect(inspectImports(path, source)).toContain(rule);
});

test.each([
  [
    'src/features/connections/connections.service.ts',
    "import type { ProviderAdapter } from '../../platform/providers/index.js';",
  ],
  [
    'src/platform/providers/telegram/setup.ts',
    "import type { ProviderAdapter } from '../contract.js';",
  ],
  ['src/features/work/work.service.ts', "import { service } from '../people/index.js';"],
  ['src/features/triage/triage.service.ts', "import { model } from '../../platform/llm/index.js';"],
  ['src/features/work/work.repository.ts', "import { eq } from 'drizzle-orm';"],
  ['src/platform/db/index.ts', "import { Pool } from 'pg'; new Pool();"],
  [
    'src/features/channels/channels.service.ts',
    "import { registry } from '../../platform/providers/index.js';",
  ],
])('allows the public boundary in %s', (path, source) => {
  expect(inspectImports(path, source)).toEqual([]);
});

test('Every source file obeys BE/be-architecture section 4 import rules I-2 to I-11', () => {
  const files = readdirSync('src', { recursive: true, withFileTypes: true });
  const violations = files
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .flatMap((entry) => {
      const path = join(entry.parentPath, entry.name);
      const source = readFileSync(path, 'utf8');
      return inspectImports(relative(process.cwd(), path), source).map(
        (rule) => `${path}: ${rule}`,
      );
    });
  expect(violations).toEqual([]);
});
