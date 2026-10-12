import type { MetricSink } from '../metrics/index.js';

export function recordTokens(
  emit: MetricSink | undefined,
  workspaceId: string | undefined,
  agent: string,
  tokens: number | undefined,
) {
  if (workspaceId && tokens !== undefined && Number.isSafeInteger(tokens) && tokens >= 0) {
    emit?.({ name: 'llm_tokens', kind: 'delta', value: tokens, agent, workspaceId });
  }
}
