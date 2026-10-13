import { expect, test } from 'vitest';
import {
  decidedBy,
  followUpVerdict,
  genesisGate,
  greyChoice,
  quantityCandidates,
  verdict,
} from '../../../../src/features/understanding/understanding.rules.js';

const thresholds = { attach: 0.75, create: 0.45, gap: 0.25 };

test.each([
  [[0.6, 0.54, 0.52], 'GREY'],
  [[0.8, 0.5], 'ATTACH'],
  [[0.4], 'CREATE'],
  [[0.75, 0.5], 'ATTACH'],
  [[0.749, 0.4], 'GREY'],
  [[0.45], 'GREY'],
  [[0.449], 'CREATE'],
  [[0.8, 0.551], 'GREY'],
  [[0.8, 0.55], 'ATTACH'],
  [[0.52, 0.6, 0.54], 'GREY'],
  [[], 'CREATE'],
] as const)(
  'SRS §6.1: verdict(%j) is %s at the 0.75, 0.45 and 0.25 boundaries',
  (scores, expected) => {
    expect(verdict(scores, thresholds)).toBe(expected);
  },
);

test('SRS §13: verdict uses calibrated thresholds passed as arguments', () => {
  expect(verdict([0.7, 0.5], { attach: 0.7, create: 0.4, gap: 0.2 })).toBe('ATTACH');
});

test('SRS §6.1: a contradicting quantity removes a candidate regardless of its score', () => {
  const candidates = [
    { id: 'wrong', quantity: 3, score: 0.99 },
    { id: 'matching', quantity: 5, score: 0.5 },
    { id: 'unknown', quantity: null, score: 0.6 },
  ];

  expect(quantityCandidates(5, candidates)).toEqual([candidates[1], candidates[2]]);
  expect(quantityCandidates(null, candidates)).toEqual(candidates);
  expect(quantityCandidates(0, [{ quantity: 1 }, { quantity: 0 }])).toEqual([{ quantity: 0 }]);
});

test.each(['status_query', 'ack', 'noise'])('SRS §7.3: genesisGate rejects %s at G1', (intent) => {
  expect(genesisGate(intent)).toBe('G1');
});

test('SRS §9.2: decidedBy is reference only for an ATTACH that the reply or explicit id decided', () => {
  expect(decidedBy('ATTACH', true)).toBe('reference');
  expect(decidedBy('ATTACH', false)).toBe('score');
  expect(decidedBy('GREY', true)).toBe('score');
  expect(decidedBy('CREATE', true)).toBe('score');
});

test('SRS §6.7: greyChoice attaches only to a cited candidate of the list and creates only with cited new work', () => {
  const supplied = { candidateIds: ['t1', 't2'], messageIds: ['m1', 'm2'] };
  const choice = (
    choiceValue: 'candidate' | 'new_work' | 'not_sure',
    threadId: string | null,
    supportingMessageIds: string[],
  ) => greyChoice({ choice: choiceValue, threadId, supportingMessageIds }, supplied);

  expect(choice('candidate', 't1', ['m1'])).toEqual({ kind: 'attach', threadId: 't1' });
  expect(choice('candidate', 't1', [])).toEqual({ kind: 'unsure' });
  expect(choice('candidate', 't1', ['foreign'])).toEqual({ kind: 'unsure' });
  expect(choice('candidate', 't9', ['m1'])).toEqual({ kind: 'unsure' });
  expect(choice('candidate', null, ['m1'])).toEqual({ kind: 'unsure' });
  expect(choice('new_work', null, ['m1'])).toEqual({ kind: 'create' });
  expect(choice('new_work', null, [])).toEqual({ kind: 'unsure' });
  expect(choice('not_sure', null, ['m1'])).toEqual({ kind: 'unsure' });
});

test('SRS §6.7 (FR-RES-03): a CREATE with recent work in its window is grey; otherwise the verdict is unchanged', () => {
  expect(followUpVerdict('CREATE', ['t1'])).toBe('GREY');
  expect(followUpVerdict('CREATE', [])).toBe('CREATE');
  expect(followUpVerdict('ATTACH', ['t1'])).toBe('ATTACH');
  expect(followUpVerdict('GREY', ['t1'])).toBe('GREY');
});
