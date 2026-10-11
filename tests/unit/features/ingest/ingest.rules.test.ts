import { expect, test } from 'vitest';
import { burstGroups } from '../../../../src/features/ingest/ingest.rules.js';

test('The 12-second debounce groups adjacent messages; a larger gap starts a new burst', () => {
  const messages = [{ serverTs: 0 }, { serverTs: 12000 }, { serverTs: 24001 }];

  expect(burstGroups(messages, 12000)).toEqual([messages.slice(0, 2), messages.slice(2)]);
  expect(burstGroups([], 12000)).toEqual([]);
});
