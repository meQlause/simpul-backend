import { detachRecordedOperation } from './understanding-context.repository.js';

export async function detachOperation(...parameters: Parameters<typeof detachRecordedOperation>) {
  await detachRecordedOperation(...parameters);
}
