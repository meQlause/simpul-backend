import type { PoolClient } from 'pg';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { ModelPort } from '../../platform/llm/port.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { queryPayload, triageClass } from './understanding.schema.js';
import { injectionSuspected } from './understanding.rules.js';
import { modelInput, markInjection, storeTriage } from './understanding.triage.repository.js';

type Payload = { workspaceId: string; unitId: string };
type Dependencies = {
  resolveConnection: ConnectionResolver;
  model: ModelPort;
  audit: (event: Payload & { injectionSuspected: true }) => void;
  publishResolve: (tx: PoolClient, payload: Payload) => Promise<unknown>;
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
    mode: 'triage',
    tier: 'triage',
    bodySafe: input.bodySafe,
    temperature: 0,
  });
  const classification = triageClass.parse(output.trim());

  await scopedTransaction(dependencies.resolveConnection, scope.workspaceId, async (tx) => {
    const changed = await storeTriage(tx, scope, classification);

    if (changed && classification !== 'NOISE') {
      await dependencies.publishResolve(tx, scope);
    }
  });
}
