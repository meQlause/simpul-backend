import { expect, test } from 'vitest';
import { sessionState } from '../../../../src/features/connections/connections-sessions.rules.js';

test.each([
  [false, false, 899999, 'pending'],
  [false, true, 899999, 'identified'],
  [false, true, 900000, 'expired'],
  [true, true, 1, 'expired'],
])('A session consumed=%s identified=%s at %s is %s', (consumed, identified, now, state) => {
  expect(sessionState({ consumed, identified, expiresAt: 900000 }, now)).toBe(state);
});
