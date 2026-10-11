import { lockSilentWork } from './work-staleness.repository.js';

export async function silentWork(...args: Parameters<typeof lockSilentWork>) {
  return lockSilentWork(...args);
}
