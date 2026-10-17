import { DomainError } from '../../errors/domain-error.js';
import { z as schema } from 'zod';

const CALL_TIMEOUT_MS = 10000;
const DEFAULT_RETRY_SECONDS = 60;
const RATE_LIMIT_STATUS = 429;
const UNAUTHORIZED_STATUS = 401;
const NOT_FOUND_STATUS = 404;
const TOKEN_STATUSES = [UNAUTHORIZED_STATUS, NOT_FOUND_STATUS];

async function readData(response: Response) {
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

function responseFailure(response: Response, data: unknown) {
  const limited = schema
    .object({ error_code: schema.literal(RATE_LIMIT_STATUS) })
    .safeParse(data).success;

  if (response.status === RATE_LIMIT_STATUS || limited) {
    const wait = schema
      .object({
        parameters: schema.object({ retry_after: schema.number().int().nonnegative().safe() }),
      })
      .safeParse(data);
    const header = schema.coerce
      .number()
      .int()
      .nonnegative()
      .safe()
      .safeParse(response.headers.get('Retry-After') ?? undefined);
    const headerWait = header.success ? header.data : DEFAULT_RETRY_SECONDS;
    const retryAfter = wait.success ? wait.data.parameters.retry_after : headerWait;

    return new DomainError('E-TG-RATE-LIMITED', undefined, retryAfter);
  }

  // Only an unknown token (401) or a malformed one (404) is a token error. Any other refusal comes
  // back as Telegram's `ok: false` body, and the caller maps it to the code its step owns.
  return TOKEN_STATUSES.includes(response.status) ? new DomainError('E-TG-TOKEN-INVALID') : null;
}

export function createCall(baseUrl: string, send: typeof fetch, callTimeoutMs = CALL_TIMEOUT_MS) {
  return async (credential: string, method: string, body?: object) => {
    try {
      const response = await send(
        `${baseUrl.replace(/\/$/u, '')}/bot${encodeURIComponent(credential)}/${method}`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(callTimeoutMs),
          redirect: 'error',
          ...(body
            ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
        },
      );
      const data = await readData(response);
      const failure = responseFailure(response, data);

      if (failure) {
        throw failure;
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
