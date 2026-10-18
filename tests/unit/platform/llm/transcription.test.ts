import { expect, test, vi } from 'vitest';
import { createGeminiTranscriber } from '../../../../src/platform/llm/transcription.js';

test('SRS §11.6: transcription reports provider tokens by workspace without audio or transcript', async () => {
  const emit = vi.fn();
  const generate = vi.fn(async () => ({
    text: 'private transcript',
    usageMetadata: { totalTokenCount: 15 },
  }));
  const transcriber = createGeminiTranscriber(
    { vertex: { project: 'test-project', location: 'global' }, model: 'standard', emit },
    generate,
  );

  await transcriber.transcribe({
    data: new Uint8Array([1, 2]),
    mimeType: 'audio/ogg',
    workspaceId: 'workspace-a',
  });
  expect(emit.mock.calls).toEqual([
    [
      {
        name: 'llm_tokens',
        kind: 'delta',
        value: 15,
        agent: 'transcription',
        workspaceId: 'workspace-a',
      },
    ],
  ]);
  expect(JSON.stringify(generate.mock.calls)).not.toContain('workspace-a');
});

test('SRS §12.4: Gemini receives bounded voice transcription instructions and the original audio bytes', async () => {
  const generate = vi.fn(async () => ({ text: '  tiga dus sudah siap  ' }));
  const transcriber = createGeminiTranscriber(
    { vertex: { project: 'test-project', location: 'global' }, model: 'configured-standard' },
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
