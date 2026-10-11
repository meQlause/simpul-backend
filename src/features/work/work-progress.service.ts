import { applyProgress, restoreProgress } from './work-progress.repository.js';
import { cancelWorkReminders } from '../delivery/index.js';

export async function recordProgress(...parameters: Parameters<typeof applyProgress>) {
  if (await applyProgress(...parameters)) {
    const [tx, scope, input] = parameters;

    await cancelWorkReminders(tx, scope.workspaceId, { threadId: scope.threadId, now: input.now });
  }
}

export async function rollback(...parameters: Parameters<typeof restoreProgress>) {
  await restoreProgress(...parameters);
}
