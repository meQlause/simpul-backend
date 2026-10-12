import { expect, test, vi } from 'vitest';
import { createGeminiModel } from '../../../../src/platform/llm/gemini.js';

const settings = {
  apiKey: 'test-key',
  models: { triage: 'triage-model', standard: 'standard-model', strong: 'strong-model' },
};

test('SRS §11.6: token metrics use provider usage per agent and workspace without message text', async () => {
  const emit = vi.fn();
  const generate = vi.fn(async () => ({ text: 'EVENT', usageMetadata: { totalTokenCount: 42 } }));
  const model = createGeminiModel({ ...settings, emit }, generate);

  await model.generate({
    workspaceId: 'workspace-a',
    mode: 'triage',
    tier: 'triage',
    bodySafe: 'customer text must not enter metrics',
    temperature: 0,
  });

  expect(emit.mock.calls).toEqual([
    [{ name: 'llm_tokens', kind: 'delta', value: 42, agent: 'triage', workspaceId: 'workspace-a' }],
  ]);
  expect(JSON.stringify(generate.mock.calls)).not.toContain('workspace-a');
});

test('SRS §11.6: missing provider usage is not reported as zero or estimated from message text', async () => {
  const emit = vi.fn();
  const model = createGeminiModel({ ...settings, emit }, async () => ({ text: 'EVENT' }));

  await model.generate({
    workspaceId: 'workspace-a',
    mode: 'triage',
    tier: 'triage',
    bodySafe: 'safe',
    temperature: 0,
  });
  expect(emit).not.toHaveBeenCalled();
});

test('SRS §7.1: a Gemini call receives body_safe, never body', async () => {
  const generate = vi.fn(async () => ({ text: 'EVENT' }));
  const model = createGeminiModel(settings, generate);
  const input = {
    mode: 'triage' as const,
    tier: 'triage' as const,
    bodySafe: '[REDACTED]',
    temperature: 0,
    body: 'private-phone-number',
  };

  expect(await model.generate(input)).toBe('EVENT');
  expect(generate).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'triage-model', contents: '[REDACTED]' }),
  );
  expect(JSON.stringify(generate.mock.calls)).not.toContain('private-phone-number');
});

test('SRS §12.1: Gemini provider failures propagate without exposing response text', async () => {
  const failure = Object.assign(new Error('429'), { status: 429 });
  const generate = vi.fn(async () => {
    throw failure;
  });
  const model = createGeminiModel(settings, generate);

  await expect(
    model.generate({ mode: 'comprehend', tier: 'standard', bodySafe: 'safe text', temperature: 0 }),
  ).rejects.toBe(failure);
});

test('SRS §12.1: the SDK uses one HTTP attempt and a 20 second cancellation deadline', async () => {
  vi.useFakeTimers();
  const generate = vi.fn(async (_request: import('@google/genai').GenerateContentParameters) => ({
    text: '{}',
  }));
  const model = createGeminiModel(settings, generate);
  const responseSchema = { type: 'object' };

  try {
    await model.generate({
      mode: 'comprehend',
      tier: 'strong',
      bodySafe: 'safe',
      temperature: 0,
      responseSchema,
    });
    const request = generate.mock.calls[0]?.[0];

    expect(request).toMatchObject({
      model: 'strong-model',
      config: {
        responseJsonSchema: responseSchema,
        responseMimeType: 'application/json',
        httpOptions: { timeout: 20000, retryOptions: { attempts: 1 } },
      },
    });
    expect(request?.config?.abortSignal?.aborted).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test('D-3: comprehension sends only the supplied safe operation context as data', async () => {
  const generate = vi.fn(async () => ({ text: '{}' }));
  const model = createGeminiModel(settings, generate);
  const context = {
    operations: [{ opId: 'operation-id', type: 'progress', evidence: '[REDACTED]' }],
  };

  await model.generate({
    mode: 'comprehend',
    tier: 'standard',
    bodySafe: 'correction',
    temperature: 0,
    context,
  });

  expect(generate).toHaveBeenCalledWith(
    expect.objectContaining({
      contents: JSON.stringify({ message: 'correction', context }),
    }),
  );
});
