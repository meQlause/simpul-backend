import { expect, test } from 'vitest';
import { groupedScore } from '../../../../src/features/understanding/understanding.rules.js';

test('SRS §6.2 / D-4: only the strongest signal per group contributes its configured weight', () => {
  expect(
    groupedScore(
      { identity: [0.4, 0.8], temporal: [0.2, 0.9], social: [] },
      { identity: 0.3, temporal: 0.25, social: 0.2 },
    ),
  ).toBeCloseTo(0.465);
  expect(groupedScore({ identity: [1, 1, 1] }, { identity: 0.3 })).toBeCloseTo(0.3);
  expect(groupedScore({ identity: [] }, { identity: 0.3 })).toBe(0);
});
