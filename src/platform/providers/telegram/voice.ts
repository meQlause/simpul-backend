import { z } from 'zod';
import { DomainError } from '../../errors/domain-error.js';
import type { ConnectionRef } from '../contract.js';
import type { createCall } from './call.js';

const MAX_VOICE_BYTES = 20_971_520;
const INTERNAL_ERROR = 'E-INTERNAL';
const reference = z.object({
  fileId: z.string().min(1),
  mimeType: z.string().regex(/^audio\/[a-z0-9.+-]+$/iu),
});
const file = z.object({
  ok: z.literal(true),
  result: z.object({
    file_path: z.string().regex(/^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.[a-z0-9]+$/iu),
    file_size: z.number().int().positive().max(MAX_VOICE_BYTES),
  }),
});

async function voiceBytes(response: Response) {
  if (!response.ok || !response.body) {
    throw new DomainError(INTERNAL_ERROR);
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  for await (const chunk of response.body) {
    size += chunk.byteLength;

    if (size > MAX_VOICE_BYTES) {
      throw new DomainError(INTERNAL_ERROR);
    }

    chunks.push(chunk);
  }

  if (!size) {
    throw new DomainError(INTERNAL_ERROR);
  }

  return new Uint8Array(Buffer.concat(chunks));
}

export function voiceDownloader(
  baseUrl: string,
  send: typeof fetch,
  call: ReturnType<typeof createCall>,
  timeoutMs: number,
) {
  return async (connection: ConnectionRef, mediaRef: string) => {
    try {
      const media = reference.parse(JSON.parse(mediaRef));
      const prepared = file.parse(
        await call(connection.credential, 'getFile', { file_id: media.fileId }),
      );
      const response = await send(
        `${baseUrl.replace(/\/$/u, '')}/file/bot${encodeURIComponent(connection.credential)}/${prepared.result.file_path}`,
        {
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        },
      );

      return { data: await voiceBytes(response), mimeType: media.mimeType };
    } catch {
      throw new DomainError(INTERNAL_ERROR);
    }
  };
}
