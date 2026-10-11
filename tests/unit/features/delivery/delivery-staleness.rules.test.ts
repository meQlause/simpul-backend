import { expect, test } from 'vitest';
import { stalenessStage } from '../../../../src/features/delivery/delivery-staleness.rules.js';

const hour = 3600000;
const input = {
  now: 13 * hour,
  lastActivityAt: 0,
  thresholdHours: 12,
  reminderCreatedAt: null,
  reminderSentAt: null,
  escalations: 0,
  escalationLimit: 1,
};

test('SRS §8.5: active work silent past its threshold gets one reminder', () => {
  expect(stalenessStage({ ...input, now: 12 * hour })).toBeNull();
  expect(stalenessStage(input)).toBe('reminder');
  expect(stalenessStage({ ...input, reminderCreatedAt: 13 * hour })).toBeNull();
});

test('SRS §8.5: after three days without an answer the supervisor is told once', () => {
  const reminded = { ...input, reminderCreatedAt: 13 * hour, reminderSentAt: 14 * hour };

  expect(stalenessStage({ ...reminded, now: 86 * hour - 1 })).toBeNull();
  expect(stalenessStage({ ...reminded, now: 86 * hour })).toBe('escalation');
  expect(stalenessStage({ ...reminded, now: 200 * hour, escalations: 1 })).toBeNull();
  expect(stalenessStage({ ...reminded, now: 200 * hour, reminderSentAt: null })).toBeNull();
  expect(stalenessStage({ ...reminded, now: 200 * hour, escalationLimit: 0 })).toBeNull();
});

test('SRS §8.5: new progress starts a fresh silence cycle', () => {
  expect(
    stalenessStage({
      ...input,
      lastActivityAt: 14 * hour,
      now: 27 * hour,
      reminderCreatedAt: 13 * hour,
      reminderSentAt: 14 * hour,
      escalations: 1,
    }),
  ).toBe('reminder');
});
