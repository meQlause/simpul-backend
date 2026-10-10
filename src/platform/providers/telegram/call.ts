import { DomainError } from '../../errors/domain-error.js';

const CALL_TIMEOUT_MS = 10000;

export function createCall(baseUrl: string, send: typeof fetch) {
  return async (credential: string, method: string, body?: object) => {
    try {
      const response = await send(
        `${baseUrl.replace(/\/$/u, '')}/bot${encodeURIComponent(credential)}/${method}`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
          redirect: 'error',
          ...(body
            ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
        },
      );
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new DomainError('E-TG-TOKEN-INVALID');
      }
      return data;
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError('E-TG-SETUP-TIMEOUT');
    }
  };
}
