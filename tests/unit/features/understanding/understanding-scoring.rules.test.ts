import { expect, test } from 'vitest';
import { groupedScore } from '../../../../src/features/understanding/understanding.rules.js';
import { rankedCandidates } from '../../../../src/features/understanding/understanding-scoring.rules.js';

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

test('SRS §6.1 (D-4): a reply or an explicit display id is a reference, and only that scores the shortcut', () => {
  const base = {
    customer: null,
    summary: 'order',
    nextStep: null,
    channelId: 'channel',
    lastActivityAt: new Date('2026-10-13T03:00:00Z'),
    items: [],
    participant: false,
    evidenceCount: 0,
    semantic: 0,
  };
  const ranked = rankedCandidates(
    [
      { ...base, id: 'reply', displayId: 'ORD-0001', reply: true },
      { ...base, id: 'explicit', displayId: 'ORD-0002', reply: false },
      { ...base, id: 'scored', displayId: 'ORD-0003', reply: false },
    ],
    { bodySafe: 'ORD-0002 sudah dikirim', channelId: 'channel', explicitIds: ['ORD-0002'] },
    {},
    Date.parse('2026-10-13T03:00:00Z'),
  );
  const byId = Object.fromEntries(ranked.candidates.map((candidate) => [candidate.id, candidate]));

  expect(byId.reply).toMatchObject({ reference: true, score: 0.95 });
  expect(byId.explicit).toMatchObject({ reference: true, score: 0.95 });
  expect(byId.scored).toMatchObject({ reference: false });
});
