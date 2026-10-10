import { insertInitialAccount } from './auth.repository.js';

export async function provisionAdmin(...parameters: Parameters<typeof insertInitialAccount>) {
  await insertInitialAccount(...parameters);
}
