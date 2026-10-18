import { expect, test, vi } from 'vitest';

vi.mock('../../../../src/platform/llm/vertex.js', () => ({ vertexClient: vi.fn(() => ({})) }));

const { vertexClient } = await import('../../../../src/platform/llm/vertex.js');
const { createGeminiModel } = await import('../../../../src/platform/llm/gemini.js');
const { createGeminiEmbedding } = await import('../../../../src/platform/llm/gemini-embedding.js');
const { createGeminiTranscriber } = await import('../../../../src/platform/llm/transcription.js');

const generation = { project: 'simpul-test', location: 'global' };
const embeddings = { project: 'simpul-test', location: 'asia-southeast1' };

test('B-9: the model and the transcriber use the generation location, embeddings their own', () => {
  createGeminiModel({
    vertex: generation,
    models: { triage: 'a', standard: 'b', strong: 'c' },
  });
  createGeminiTranscriber({ vertex: generation, model: 'b' });
  createGeminiEmbedding({ vertex: embeddings, model: 'gemini-embedding-001' });

  expect(vi.mocked(vertexClient).mock.calls).toEqual([[generation], [generation], [embeddings]]);
});
