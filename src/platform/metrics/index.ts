import type { Logger } from 'pino';

type Metric = {
  name:
    | 'queue_depth'
    | 'queue_active'
    | 'queue_failed'
    | 'correction_rate'
    | 'unclaimed_density'
    | 'llm_tokens'
    | 'rls_failure'
    | 'metrics_collection_failure';
  kind: 'gauge' | 'delta';
  value: number;
  workspaceId?: string;
  stage?: string;
  agent?: string;
  databaseId?: string;
  numerator?: number;
  denominator?: number;
  windowSeconds?: number;
  sampledAt?: string;
};

export type MetricSink = (metric: Metric) => void;

export function createMetricSink(logger: Logger): MetricSink {
  const metrics = logger.child({}, { level: 'info' });

  return (metric) =>
    metrics.info(
      {
        metric: metric.name,
        kind: metric.kind,
        value: metric.value,
        workspaceId: metric.workspaceId,
        stage: metric.stage,
        agent: metric.agent,
        databaseId: metric.databaseId,
        numerator: metric.numerator,
        denominator: metric.denominator,
        windowSeconds: metric.windowSeconds,
        sampledAt: metric.sampledAt,
      },
      'Operational metric',
    );
}
