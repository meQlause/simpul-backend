import type { PoolClient } from 'pg';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { ModelPort } from '../../platform/llm/port.js';
import { z } from 'zod';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { queryPayload, triageOutput } from './understanding.schema.js';
import { injectionSuspected } from './understanding.rules.js';
import { readTriage } from './understanding-triage.rules.js';
import { modelInput, markInjection, storeTriage } from './understanding.triage.repository.js';

type Payload = { workspaceId: string; unitId: string };
type Dependencies = {
  resolveConnection: ConnectionResolver;
  model: ModelPort;
  audit: (event: Payload & { injectionSuspected: true }) => void;
  publishResolve: (tx: PoolClient, payload: Payload) => Promise<unknown>;
  // Optional: a caller that does not embed (tests, the replay) leaves the unit without a vector until the backfill.
  publishEmbed?: (tx: PoolClient, payload: Payload) => Promise<unknown>;
};

export async function triageUnit(dependencies: Dependencies, payload: Payload) {
  const scope = queryPayload.parse(payload);
  const input = await scopedTransaction(dependencies.resolveConnection, scope.workspaceId, (tx) =>
    modelInput(tx, scope),
  );

  if (!input || input.triageClass !== null) {
    return;
  }

  if (injectionSuspected(input.bodySafe)) {
    const changed = await scopedTransaction(
      dependencies.resolveConnection,
      scope.workspaceId,
      (tx) => markInjection(tx, scope),
    );

    if (changed) {
      dependencies.audit({ ...scope, injectionSuspected: true });
    }
  }

  const output = await dependencies.model.generate({
    workspaceId: scope.workspaceId,
    mode: 'triage',
    tier: 'triage',
    bodySafe: input.bodySafe,
    temperature: 0,
    responseSchema: z.toJSONSchema(triageOutput),
    context: { operations: [], localDate: input.localDate, weekday: input.weekday },
  });
  const triage = readTriage(output);

  await scopedTransaction(dependencies.resolveConnection, scope.workspaceId, async (tx) => {
    const changed = await storeTriage(tx, scope, triage);

    if (changed && triage.triageClass !== 'NOISE') {
      await dependencies.publishResolve(tx, scope);
      await dependencies.publishEmbed?.(tx, scope);
    }
  });
}
