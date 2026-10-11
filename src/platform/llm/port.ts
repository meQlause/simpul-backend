type ModelRequest = {
  mode: 'triage' | 'comprehend';
  tier: 'triage' | 'standard' | 'strong';
  bodySafe: string;
  temperature: number;
  signal?: AbortSignal;
};

export type ModelPort = { generate: (request: ModelRequest) => Promise<string> };
