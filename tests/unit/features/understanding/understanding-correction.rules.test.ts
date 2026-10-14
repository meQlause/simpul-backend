import { expect, test } from 'vitest';
import { correctionRefusal } from '../../../../src/features/understanding/understanding-correction.rules.js';

const untouched = { startedThreadId: null, currentThreadId: null };

test('T4: create on a unit that already started work is refused on action; attach refusals name the field', () => {
  expect(
    correctionRefusal({ startedThreadId: 'thread-1', currentThreadId: null }, { action: 'create' }),
  ).toEqual({ field: 'action', message: 'This message already started this work.' });

  for (const status of ['completed', 'cancelled', 'archived']) {
    expect(
      correctionRefusal(untouched, {
        action: 'attach',
        target: { id: 'thread-2', status },
      }),
    ).toEqual({ field: 'workDisplayId', message: 'Choose work that is still open.' });
  }

  expect(
    correctionRefusal(
      { startedThreadId: null, currentThreadId: 'thread-1' },
      { action: 'attach', target: { id: 'thread-1', status: 'active' } },
    ),
  ).toEqual({ field: 'workDisplayId' });
});

test('T4: an active or tentative target, and create on an unstarted unit, pass', () => {
  expect(correctionRefusal(untouched, { action: 'create' })).toBeNull();
  expect(
    correctionRefusal(untouched, {
      action: 'attach',
      target: { id: 'thread-2', status: 'active' },
    }),
  ).toBeNull();
  expect(
    correctionRefusal(untouched, {
      action: 'attach',
      target: { id: 'thread-2', status: 'tentative' },
    }),
  ).toBeNull();
});
