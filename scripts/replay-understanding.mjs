import process from 'node:process';
import console from 'node:console';
import { createSystemPool } from '../dist/platform/db/index.js';
import { createConnectionResolver } from '../dist/platform/db/connection-resolver.js';
import { createQueue, publishResolution } from '../dist/platform/queue/index.js';
import { replayModelFailure } from '../dist/features/understanding/understanding.replay.js';

const [workspaceId, unitId] = process.argv.slice(2);

if (!process.env.DATABASE_URL || !workspaceId || !unitId) {
  throw new Error('Set DATABASE_URL and pass workspaceId unitId');
}

const pool = createSystemPool(process.env.DATABASE_URL);
let queue;

try {
  queue = await createQueue(pool);
  const replayed = await replayModelFailure(
    { resolveConnection: createConnectionResolver(pool), publishResolve: publishResolution(queue) },
    { workspaceId, unitId },
  );
  console.log(replayed ? 'Replay queued' : 'No model failure found');
} finally {
  await queue?.stop();
  await pool.end();
}
