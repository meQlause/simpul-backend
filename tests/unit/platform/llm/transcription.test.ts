import { expect, test, vi } from 'vitest';
import { createGeminiTranscriber } from '../../../../src/platform/llm/transcription.js';

test('SRS §12.4: Gemini receives bounded voice transcription instructions and the original audio bytes', async () => {
  const generate = vi.fn(async () => ({ text: '  tiga dus sudah siap  ' }));
  const transcriber = createGeminiTranscriber(
    { apiKey: 'test-only', model: 'configured-standard' },
    generate,
  );

  expect(
    await transcriber.transcribe({ data: new Uint8Array([1, 2]), mimeType: 'audio/ogg' }),
  ).toBe('tiga dus sudah siap');
  expect(generate).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'configured-standard',
      contents: [
        { role: 'user', parts: [{ inlineData: { data: 'AQI=', mimeType: 'audio/ogg' } }] },
      ],
      config: expect.objectContaining({
        temperature: 0,
        abortSignal: expect.any(AbortSignal),
        httpOptions: { timeout: 20000, retryOptions: { attempts: 1 } },
      }),
    }),
  );
});
