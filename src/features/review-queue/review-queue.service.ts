import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { PoolClient } from 'pg';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { ensureAlias, requireActiveCategory } from '../vocabulary/index.js';
import { recategorizeLabel } from '../understanding/index.js';
import { recordConfigChange } from '../audit/index.js';
import {
  selectReview,
  selectReviewItem,
  reviewCounts,
  markResolved,
  insertUnrouted,
} from './review-queue.repository.js';
import { reviewDto } from './review-queue.mapper.js';
import { encodeReviewCursor, parseReviewResolution } from './review-queue.schema.js';
import type { parseReviewQuery } from './review-queue.schema.js';

export type ReviewServices = {
  now: () => Date;
  publishMatcher?: (
    tx: PoolClient,
    payload: { workspaceId: string; labelId: string },
  ) => Promise<unknown>;
};

export async function raiseUnrouted(...parameters: Parameters<typeof insertUnrouted>) {
  await insertUnrouted(...parameters);
}

async function applyResolution(
  tx: PoolClient,
  scope: { workspaceId: string; actorId: string },
  selection: {
    row: { labelId: string | null; detected: { text: string | null } };
    input: ReturnType<typeof parseReviewResolution>;
  },
  services: ReviewServices,
) {
  const { row, input } = selection;

  if ('personId' in input) {
    if (!row.detected.text) {
      throw new DomainError('E-VALIDATION');
    }

    await ensureAlias(tx, scope, { personId: input.personId, alias: row.detected.text });

    return;
  }

  await requireActiveCategory(tx, scope.workspaceId, input.categoryId);
  await recategorizeLabel(tx, scope.workspaceId, row.labelId, input.categoryId);

  if (!services.publishMatcher) {
    throw new DomainError('E-INTERNAL');
  }

  await services.publishMatcher(tx, { workspaceId: scope.workspaceId, labelId: row.labelId! });
}

export async function listReview(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
  input: ReturnType<typeof parseReviewQuery>,
) {
  return scopedTransaction(resolveConnection, workspaceId, async (tx) => {
    const result = await selectReview(tx, workspaceId, input);
    const page = result.rows.slice(0, input.limit);

    return {
      data: page.map(reviewDto),
      page: {
        total: result.total,
        nextCursor:
          result.rows.length > input.limit ? encodeReviewCursor(page.at(-1)!, input) : null,
      },
      counts: await reviewCounts(tx, workspaceId),
    };
  });
}

export async function getReview(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
  id: string,
) {
  return scopedTransaction(resolveConnection, workspaceId, async (tx) => {
    const row = await selectReviewItem(tx, workspaceId, id);

    if (!row) {
      throw new DomainError('E-NOT-FOUND');
    }

    return reviewDto(row);
  });
}

export async function resolveReview(
  services: ReviewServices & { resolveConnection: ConnectionResolver },
  scope: { workspaceId: string; actorId: string },
  id: string,
  body: unknown,
) {
  return scopedTransaction(services.resolveConnection, scope.workspaceId, async (tx) => {
    const row = await selectReviewItem(tx, scope.workspaceId, id, true);

    if (!row) {
      throw new DomainError('E-NOT-FOUND');
    }

    const input = parseReviewResolution(row.kind, body);

    await applyResolution(tx, scope, { row, input }, services);
    const now = services.now();

    await markResolved(tx, scope, id, now);
    await recordConfigChange(tx, {
      ...scope,
      tableName: 'review_items',
      recordId: id,
      before: reviewDto(row),
      after: { ...input, resolvedAt: now.toISOString(), resolvedBy: scope.actorId },
    });

    return {
      id,
      resolvedAt: now.toISOString(),
      remaining: await reviewCounts(tx, scope.workspaceId),
    };
  });
}
