import type { EmbeddingPort } from './port.js';
import { vertexClient } from './vertex.js';
import type { EmbedContentParameters } from '@google/genai';

type Settings = { vertex: { project: string; location: string }; model: string };
type Embed = (request: EmbedContentParameters) => Promise<{ embeddings?: { values?: number[] }[] }>;

const dimensions = 768;
const timeoutMs = 20000;
const tasks = { document: 'RETRIEVAL_DOCUMENT', query: 'RETRIEVAL_QUERY' } as const;

// Unit text is embedded as a document; a search query as a query (FR-RES-06).
export function createGeminiEmbedding(settings: Settings, embed?: Embed): EmbeddingPort {
  const client = vertexClient(settings.vertex);
  const embedContent =
    embed ?? ((request: EmbedContentParameters) => client.models.embedContent(request));

  return {
    async embed({ text, task }) {
      const output = await embedContent({
        model: settings.model,
        contents: text,
        config: {
          outputDimensionality: dimensions,
          taskType: tasks[task],
          httpOptions: { timeout: timeoutMs, retryOptions: { attempts: 1 } },
        },
      });
      const values = output.embeddings?.[0]?.values ?? [];

      if (values.length !== dimensions) {
        throw new Error(`embedding has ${values.length} values, expected ${dimensions}`);
      }

      // Unit length, as the data spec stores it; cosine similarity is the same either way.
      const length = Math.hypot(...values);

      return values.map((value) => value / length);
    },
  };
}
