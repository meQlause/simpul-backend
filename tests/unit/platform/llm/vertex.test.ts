import { expect, test, vi } from 'vitest';

vi.mock('@google/genai', () => ({ GoogleGenAI: vi.fn() }));

const { GoogleGenAI } = await import('@google/genai');
const { vertexClient } = await import('../../../../src/platform/llm/vertex.js');

test('B-9: a model client is built for Vertex AI with the project and location, never an API key', () => {
  vertexClient({ project: 'simpul-test', location: 'global' });

  expect(GoogleGenAI).toHaveBeenCalledWith({
    vertexai: true,
    project: 'simpul-test',
    location: 'global',
  });
});
