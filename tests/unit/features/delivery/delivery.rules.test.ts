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

test('SRS §6.7 (FR-UI-19): a clarification lists its candidates numbered, with None of these last', () => {
  const id = '00000000-0000-4000-8000-000000000f01';
  const labels = ['ORD-0001 — Toko Berkah', 'ORD-0002 — Toko Maju', 'ORD-0003 — Toko Jaya'];

  expect(delivery.questionActions(id, labels, true)).toEqual([
    { id: `q:${id}:1`, label: '1 · ORD-0001 — Toko Berkah' },
    { id: `q:${id}:2`, label: '2 · ORD-0002 — Toko Maju' },
    { id: `q:${id}:3`, label: '3 · ORD-0003 — Toko Jaya' },
    { id: `q:${id}:4`, label: '4 · None of these' },
  ]);
  expect(delivery.questionActions(id, labels, false).map((action) => action.label)).toEqual([
    ...labels,
    'None of these',
  ]);
});

test('SRS §6.7 (FR-RES-02): a question answer maps a number to a candidate, and the last number to none', () => {
  const threads = ['t1', 't2', 't3'];

  expect(delivery.questionAnswer(1, threads)).toBe('t1');
  expect(delivery.questionAnswer(3, threads)).toBe('t3');
  expect(delivery.questionAnswer(4, threads)).toBe('none');
  expect(delivery.questionAnswer(0, threads)).toBeUndefined();
  expect(delivery.questionAnswer(5, threads)).toBeUndefined();
  expect(delivery.questionAnswer(2, ['t1'])).toBe('none');
});
