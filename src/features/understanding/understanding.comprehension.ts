import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { ModelPort } from '../../platform/llm/port.js';
import { z } from 'zod';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { modelInput } from './understanding.triage.repository.js';
import { comprehensionScope, comprehensionOutput } from './understanding.schema.js';
import { hasOutcome, insertOrphan, lockUnlabelledUnit } from './understanding.repository.js';
import { storeComprehension } from './understanding.service.js';

const defaultTemperature = 0.2;

type Scope = { workspaceId: string; unitId: string; threadId: string };
type Dependencies = {
  resolveConnection: ConnectionResolver;
  model: ModelPort;
  alert: (event: Scope & { reason: 'model_invalid_json' }) => void;
};

function decode(text: string) {
  try {
    return comprehensionOutput.safeParse(JSON.parse(text));
  } catch {
    return null;
  }
}

async function quarantine(dependencies: Dependencies, scope: Scope) {
  const changed = await scopedTransaction(
    dependencies.resolveConnection,
    scope.workspaceId,
    async (tx) => {
      if (!(await lockUnlabelledUnit(tx, scope))) {
        return false;
      }

      return insertOrphan(tx, scope, 'model_invalid_json');
    },
  );

  if (changed) {
    dependencies.alert({ ...scope, reason: 'model_invalid_json' });
  }
}

export async function comprehendUnit(dependencies: Dependencies, payload: Scope) {
  const scope = comprehensionScope.parse(payload);
  const input = await scopedTransaction(
    dependencies.resolveConnection,
    scope.workspaceId,
    async (tx) => {
      if (await hasOutcome(tx, scope)) {
        return null;
      }

      return modelInput(tx, scope);
    },
  );

  if (!input) {
    return;
  }

  for (const temperature of [defaultTemperature, 0]) {
    const output = await dependencies.model.generate({
      mode: 'comprehend',
      tier: 'standard',
      bodySafe: input.bodySafe,
      temperature,
      responseSchema: z.toJSONSchema(comprehensionOutput),
    });
    const decoded = decode(output);

    if (decoded?.success) {
      await storeComprehension(dependencies.resolveConnection, scope, decoded.data);

      return;
    }
  }

  await quarantine(dependencies, scope);
}
