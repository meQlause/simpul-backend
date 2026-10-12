import { expect, test } from 'vitest';
import { createMetricSink } from '../../../../src/platform/metrics/index.js';
import { createLogger } from '../../../../src/platform/logger/index.js';

test('SRS §11.6: operational logs contain only metric fields even at a warning log level', () => {
  const lines: string[] = [];
  const emit = createMetricSink(createLogger('warn', { write: (line) => lines.push(line) }));

  emit({
    name: 'llm_tokens',
    kind: 'delta',
    value: 42,
    agent: 'triage',
    workspaceId: 'workspace-a',
    ...{ body: 'customer text', token: 'test-secret' },
  });
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toMatchObject({
    metric: 'llm_tokens',
    kind: 'delta',
    value: 42,
    agent: 'triage',
    workspaceId: 'workspace-a',
  });
  expect(lines[0]).not.toContain('customer text');
  expect(lines[0]).not.toContain('test-secret');
});
