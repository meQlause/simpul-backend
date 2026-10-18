import { expect, test, vi } from 'vitest';
import { createGeminiEmbedding } from '../../../../src/platform/llm/gemini-embedding.js';

const settings = {
  vertex: { project: 'test-project', location: 'global' },
  model: 'embedding-model',
};
const vector = (length: number) => Array.from({ length }, () => 0.1);

// T3 — AC1, AC3: one 768-value vector per text, with the task the caller names; a wrong length is refused.
test('RAG (AC1, AC3): the adapter sends the model, the text, 768 dimensions and the task type', async () => {
  const embedContent = vi.fn(async () => ({ embeddings: [{ values: vector(768) }] }));
  const embedding = createGeminiEmbedding(settings, embedContent);

  const values = await embedding.embed({ text: 'pesanan Toko Berkah', task: 'query' });

  expect(values).toHaveLength(768);
  expect(Math.hypot(...values)).toBeCloseTo(1);
  await embedding.embed({ text: 'pesanan dibatalkan', task: 'document' });

  expect(embedContent.mock.calls).toEqual([
    [
      {
        model: 'embedding-model',
        contents: 'pesanan Toko Berkah',
        config: {
          outputDimensionality: 768,
          taskType: 'RETRIEVAL_QUERY',
          httpOptions: { timeout: 20000, retryOptions: { attempts: 1 } },
        },
      },
    ],
    [
      {
        model: 'embedding-model',
        contents: 'pesanan dibatalkan',
        config: {
          outputDimensionality: 768,
          taskType: 'RETRIEVAL_DOCUMENT',
          httpOptions: { timeout: 20000, retryOptions: { attempts: 1 } },
        },
      },
    ],
  ]);
});

test('RAG (AC1): a vector of another length is refused', async () => {
  const embedding = createGeminiEmbedding(settings, async () => ({
    embeddings: [{ values: vector(10) }],
  }));

  await expect(embedding.embed({ text: 'x', task: 'document' })).rejects.toThrow();
});
