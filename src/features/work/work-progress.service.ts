import { applyProgress, restoreProgress } from './work-progress.repository.js';

export async function recordProgress(...parameters: Parameters<typeof applyProgress>) {
  await applyProgress(...parameters);
}

export async function rollback(...parameters: Parameters<typeof restoreProgress>) {
  await restoreProgress(...parameters);
}
