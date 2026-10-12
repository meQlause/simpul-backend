import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import type { MetricSink } from '../metrics/index.js';
import { scopedTransaction } from './scoped-transaction.js';

export type MetricServices = { emit: MetricSink; now: () => Date; databaseId?: string };

type Counts = { sent: number; corrected: number; messages: number; unclaimed: number };
const DAY_SECONDS = 86400;
const CORRECTION_WINDOW_SECONDS = 2592000;

async function workspaceMetrics(pool: Pool, workspaceId: string, services: MetricServices) {
  try {
    const counts = await scopedTransaction(
      async () => pool,
      workspaceId,
      async (tx) => {
        const result = await tx.query<Counts>(
          `WITH sent AS (
          SELECT DISTINCT label.op_id FROM notifications notification
          JOIN labels label ON label.id = notification.label_id AND label.workspace_id = $1
          WHERE notification.workspace_id = $1 AND notification.kind = 'update'
            AND notification.sent_at >= $2::timestamptz - interval '30 days'
            AND notification.sent_at <= $2
        ), messages AS (
          SELECT message.id FROM messages_raw message
          WHERE message.workspace_id = $1
            AND message.server_ts >= $2::timestamptz - interval '24 hours'
            AND message.server_ts <= $2
            AND EXISTS (SELECT 1 FROM unit_messages link JOIN units unit ON unit.id = link.unit_id
              AND unit.workspace_id = $1 WHERE link.workspace_id = $1 AND link.message_id = message.id
                AND unit.triage_class IN ('EVENT', 'QUERY'))
        )
        SELECT (SELECT count(*)::int FROM sent) AS sent,
          (SELECT count(DISTINCT correction.op_id)::int FROM corrections correction
            JOIN sent ON sent.op_id = correction.op_id WHERE correction.workspace_id = $1
              AND correction.created_at >= $2::timestamptz - interval '30 days'
              AND correction.created_at <= $2) AS corrected,
          (SELECT count(*)::int FROM messages) AS messages,
          (SELECT count(*)::int FROM messages message WHERE NOT EXISTS (
            SELECT 1 FROM message_thread_link link WHERE link.workspace_id = $1
              AND link.message_id = message.id)) AS unclaimed`,
          [workspaceId, services.now()],
        );

        return result.rows[0];
      },
    );

    for (const [name, numerator, denominator, windowSeconds] of [
      ['correction_rate', counts.corrected, counts.sent, CORRECTION_WINDOW_SECONDS],
      ['unclaimed_density', counts.unclaimed, counts.messages, DAY_SECONDS],
    ] as const) {
      services.emit({
        name,
        kind: 'gauge',
        value: numerator / Math.max(1, denominator),
        numerator,
        denominator,
        workspaceId,
        windowSeconds,
      });
    }
  } catch {
    services.emit({ name: 'metrics_collection_failure', kind: 'delta', value: 1, workspaceId });
  }
}

async function reportQueues(queue: PgBoss, services: MetricServices) {
  for (const registered of await queue.getQueues()) {
    const [stats] = await queue.getQueueStats(registered.name, { force: true });

    for (const [name, value] of [
      ['queue_depth', stats.queuedCount],
      ['queue_active', stats.activeCount],
      ['queue_failed', stats.failedCount],
    ] as const) {
      services.emit({
        name,
        kind: 'gauge',
        value,
        stage: registered.name,
        databaseId: services.databaseId ?? 'hosted',
        sampledAt: stats.capturedOn.toISOString(),
      });
    }
  }
}

export async function reportMetrics(queue: PgBoss, pool: Pool, services: MetricServices) {
  try {
    await reportQueues(queue, services);

    const workspaces = await pool.query<{ id: string }>('SELECT id FROM scheduled_workspaces()');

    await Promise.all(
      workspaces.rows.map((workspace) => workspaceMetrics(pool, workspace.id, services)),
    );
  } catch {
    services.emit({
      name: 'metrics_collection_failure',
      kind: 'delta',
      value: 1,
      databaseId: services.databaseId ?? 'hosted',
    });
  }
}
