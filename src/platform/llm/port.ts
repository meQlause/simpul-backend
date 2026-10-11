type ModelRequest = {
  mode: 'triage' | 'comprehend';
  tier: 'triage' | 'standard' | 'strong';
  bodySafe: string;
  temperature: number;
  signal?: AbortSignal;
  responseSchema?: Record<string, unknown>;
  context?: { operations: { opId: string; type: string; evidence: string }[] };
};

export type ModelPort = { generate: (request: ModelRequest) => Promise<string> };
