import type { ReviewRow } from './review-queue.repository.js';

export function reviewDto(row: ReviewRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    channel: row.channel,
    detectedAt: row.detectedAt.toISOString(),
    detected: row.detected,
  };
}
