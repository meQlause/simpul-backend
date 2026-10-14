import { expect, test } from 'vitest';
import {
  messageRow,
  scoreText,
  type MessageFacts,
} from '../../../../src/features/audit/audit-messages.rules.js';

const base: MessageFacts = {
  unitId: '00000000-0000-4000-8000-0000000000a1',
  occurredAt: '2026-10-10T04:00:00.000Z',
  channel: { id: 'channel-1', name: 'Sales & Order' },
  senderName: 'Budi Santoso',
  text: 'ada pesanan baru',
  outcome: 'rejected',
  reason: 'G3',
  triageClass: 'EVENT',
  work: null,
  correction: null,
  resolution: null,
  decisionId: null,
};

const keys = (row: ReturnType<typeof messageRow>) => row.steps.map((step) => step.key);

test('AC2: a rejected, held, ignored or pending unit lists its steps in order and maps each outcome to a status', () => {
  const rejected = messageRow({
    ...base,
    resolution: { verdict: 'CREATE', decidedBy: 'score', contextMessages: 0, candidates: [] },
  });
  const held = messageRow({
    ...base,
    outcome: 'held',
    reason: 'question',
    resolution: { verdict: 'GREY', decidedBy: 'question', contextMessages: 2, candidates: [] },
  });
  const ignored = messageRow({
    ...base,
    outcome: 'ignored',
    reason: 'NOISE',
    triageClass: 'NOISE',
  });
  const pending = messageRow({ ...base, outcome: 'pending', reason: null });

  expect(keys(rejected)).toEqual(['read', 'matched', 'outcome']);
  expect(rejected.steps.at(-1)).toEqual({ key: 'outcome', status: 'failed', reason: 'G3' });
  expect(held.steps.at(-1)).toEqual({ key: 'outcome', status: 'held', reason: 'question' });
  expect(ignored.steps.at(-1)).toEqual({ key: 'outcome', status: 'done', reason: 'NOISE' });
  expect(pending.steps.at(-1)).toMatchObject({ key: 'outcome', status: 'pending' });
  expect(rejected.steps[0]).toEqual({ key: 'read', triageClass: 'EVENT' });
});

test('AC3: scores read with two decimals, and at most three candidates are listed', () => {
  expect(scoreText(0.5849)).toBe('0.58');
  expect(scoreText(0.005)).toBe('0.01');

  const row = messageRow({
    ...base,
    resolution: {
      verdict: 'GREY',
      decidedBy: 'model_context',
      contextMessages: 2,
      candidates: [
        { displayId: 'ORD-0091', summary: 'a', score: 0.9 },
        { displayId: 'ORD-0098', summary: 'b', score: 0.8 },
        { displayId: 'ORD-0095', summary: 'c', score: 0.7 },
        { displayId: 'ORD-0010', summary: 'd', score: 0.6 },
      ],
    },
  });
  const matched = row.steps.find((step) => step.key === 'matched');

  expect(matched).toMatchObject({
    verdict: 'GREY',
    decidedBy: 'model_context',
    contextMessages: 2,
  });
  expect(matched && 'candidates' in matched ? matched.candidates : []).toHaveLength(3);
  expect(matched && 'candidates' in matched ? matched.candidates[0] : null).toEqual({
    displayId: 'ORD-0091',
    summary: 'a',
    score: '0.90',
  });
});

test('AC2, AC4 edge: no resolution gives no matched step, no decision gives no notified step, and NOISE gives read and outcome only', () => {
  expect(keys(messageRow(base))).toEqual(['read', 'outcome']);
  expect(keys(messageRow({ ...base, decisionId: null }))).not.toContain('notified');
  expect(keys(messageRow({ ...base, decisionId: 'decision-1' }))).toContain('notified');
  expect(
    keys(
      messageRow({
        ...base,
        triageClass: 'NOISE',
        resolution: { verdict: 'CREATE', decidedBy: 'score', contextMessages: 0, candidates: [] },
      }),
    ),
  ).toEqual(['read', 'outcome']);
});
