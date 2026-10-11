import { expect, test } from 'vitest';
import * as delivery from '../../../../src/features/delivery/delivery.rules.js';

const actions = [
  { id: 'resolution', label: 'Already shipped' },
  { id: 'progress', label: 'In progress' },
  { id: 'blocker', label: 'There is a blocker' },
  { id: 'correction', label: 'Not this work' },
];

test('SRS §8.1: an accepted resolution can notify after its own status transition completes the work', () => {
  const label = {
    type: 'resolution',
    tense: 'sudah_terjadi',
    evidenceMessageIds: ['message'],
    confidence: 0.9,
  };

  expect(delivery.claimGate(label, { status: 'completed', historical: false })).toBe(true);
  expect(
    delivery.claimGate({ ...label, type: 'progress' }, { status: 'completed', historical: false }),
  ).toBe(false);
  expect(delivery.claimGate(label, { status: 'completed', historical: true })).toBe(false);
});

test('NFR-AD-03: renderActions draws buttons when the adapter declares inlineActions', () => {
  expect(delivery.renderActions(actions, { inlineActions: true })).toEqual({ actions, text: '' });
});

test('NFR-AD-03: without inlineActions, renderActions draws a numbered list answered by text', () => {
  expect(delivery.renderActions(actions, { inlineActions: false })).toEqual({
    text: '1. Already shipped\n2. In progress\n3. There is a blocker\n4. Not this work',
  });
  expect(delivery.renderActions([], { inlineActions: false })).toEqual({ text: '' });
});

test.each([
  ['20:59', 'normal', false],
  ['21:00', 'normal', true],
  ['23:59', 'normal', true],
  ['00:00', 'normal', true],
  ['06:59', 'normal', true],
  ['07:00', 'normal', false],
  ['00:00', 'high', false],
])('SRS 8.4: 21:00–07:00 holds non-urgent delivery at %s (%s)', (localTime, urgency, expected) => {
  expect(
    delivery.quietHoursHold({ localTime, urgency, quietStart: '21:00', quietEnd: '07:00' }),
  ).toBe(expected);
});

test.each([
  ['09:00', true],
  ['12:59', true],
  ['13:00', false],
  ['08:59', false],
])(
  'SRS 8.4: a daytime quiet interval also respects its boundaries at %s',
  (localTime, expected) => {
    expect(
      delivery.quietHoursHold({
        localTime,
        quietStart: '09:00',
        quietEnd: '13:00',
        urgency: 'normal',
      }),
    ).toBe(expected);
  },
);
