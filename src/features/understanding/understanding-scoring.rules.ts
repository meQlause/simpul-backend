import { groupedScore, quantityCandidates } from './understanding.rules.js';

type Candidate = {
  id: string;
  displayId: string;
  customer: string | null;
  summary: string;
  nextStep: string | null;
  channelId: string;
  lastActivityAt: Date;
  items: { quantity?: number; qty?: number }[];
  participant: boolean;
  reply: boolean;
  evidenceCount: number;
  semantic: number;
};
const millisecondsPerHour = 3600000;
const recencyHours = 72;
const staleHours = 240;
const evidenceWindow = 8;
const shortcutScore = 0.95;
const minimumWordLength = 3;

function textOverlap(body: string, text: string | null) {
  const words =
    (text ?? '')
      .toLocaleLowerCase()
      .match(/\p{L}+/gu)
      ?.filter((word) => word.length >= minimumWordLength) ?? [];

  return words.length
    ? words.filter((word) => body.toLocaleLowerCase().includes(word)).length / words.length
    : 0;
}

function rank(
  candidate: Candidate,
  source: { bodySafe: string; channelId: string },
  weights: Record<string, number>,
  now: number,
) {
  const ageHours = Math.max(0, (now - candidate.lastActivityAt.getTime()) / millisecondsPerHour);
  const score = groupedScore(
    {
      identity: [
        textOverlap(source.bodySafe, candidate.customer),
        textOverlap(source.bodySafe, candidate.summary),
      ],
      temporal: [1 / (1 + ageHours / recencyHours)],
      social: [Number(candidate.participant)],
      procedural: [textOverlap(source.bodySafe, candidate.nextStep)],
      semantic: [candidate.semantic, Math.min(1, candidate.evidenceCount / evidenceWindow)],
    },
    weights,
  );

  return score * Math.max(0, 1 - ageHours / staleHours);
}

export function rankedCandidates(
  candidates: Candidate[],
  source: { bodySafe: string; channelId: string; explicitIds: string[] },
  weights: Record<string, number>,
  now: number,
) {
  const quantityText = source.bodySafe.match(
    /\b(\d+(?:\.\d+)?)\s*(?:dus|cases?|karton|boxes?)\b/iu,
  )?.[1];
  const quantity = quantityText === undefined ? null : Number(quantityText);
  const ranked = candidates.map((candidate) => ({
    id: candidate.id,
    quantity:
      candidate.items.length === 1
        ? (candidate.items[0]?.quantity ?? candidate.items[0]?.qty ?? null)
        : null,
    score:
      candidate.reply || source.explicitIds.includes(candidate.displayId)
        ? shortcutScore
        : rank(candidate, source, weights, now),
  }));

  return {
    quantity,
    candidates: quantityCandidates(quantity, ranked).toSorted(
      (left, right) => right.score - left.score,
    ),
  };
}
