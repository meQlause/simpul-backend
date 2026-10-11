import type { PoolClient } from 'pg';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordConfigChange } from '../audit/index.js';
import { selectReviewItem, markResolved } from './review-queue.repository.js';
import { reviewDto } from './review-queue.mapper.js';

export async function resolveRoutingReview(
  tx: PoolClient,
  scope: { workspaceId: string; actorId: string },
  id: string,
  now: Date,
) {
  const row = await selectReviewItem(tx, scope.workspaceId, id, true);

  if (!row || row.kind !== 'unrouted') {
    throw new DomainError('E-VALIDATION');
  }

  await markResolved(tx, scope, id, now);
  await recordConfigChange(tx, {
    ...scope,
    tableName: 'review_items',
    recordId: id,
    before: reviewDto(row),
    after: { resolvedAt: now.toISOString(), resolvedBy: scope.actorId },
  });
}
