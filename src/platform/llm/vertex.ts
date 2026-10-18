import { GoogleGenAI } from '@google/genai';

// B-9: every model call goes through Vertex AI as the process's Google identity; there is no key.
export function vertexClient(settings: { project: string; location: string }) {
  return new GoogleGenAI({
    vertexai: true,
    project: settings.project,
    location: settings.location,
  });
}
