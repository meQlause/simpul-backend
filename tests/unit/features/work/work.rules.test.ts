import { expect, test } from 'vitest';
import { displayStatus } from '../../../../src/features/work/work.rules.js';

const thread = {
  status: 'active' as const,
  lastActivityAt: Date.parse('2026-10-09T16:02:00+07:00'),
};
const now = Date.parse('2026-10-10T11:01:00+07:00');

test('displayStatus returns stalled for ORD-0091 at 2026-10-10 11:01 WIB with a 12-hour threshold, and active with 24', () => {
  expect(displayStatus(thread, 12, now)).toBe('stalled');
  expect(displayStatus(thread, 24, now)).toBe('active');
});

test('Stalled requires silence strictly greater than the category threshold', () => {
  expect(displayStatus(thread, 12, thread.lastActivityAt + 12 * 3600000)).toBe('active');
  expect(displayStatus(thread, 12, thread.lastActivityAt + 12 * 3600000 + 1)).toBe('stalled');
});

test.each(['tentative', 'completed', 'cancelled', 'archived'] as const)(
  'Stored %s status is not derived as stalled',
  (status) => {
    expect(displayStatus({ ...thread, status }, 12, now)).toBe(status);
  },
);
