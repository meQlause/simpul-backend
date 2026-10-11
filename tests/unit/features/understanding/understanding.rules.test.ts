import { expect, test } from 'vitest';
import { verdict } from '../../../../src/features/understanding/understanding.rules.js';

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
