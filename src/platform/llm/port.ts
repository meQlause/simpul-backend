type ModelRequest = {
  workspaceId?: string;
  mode: 'triage' | 'comprehend' | 'genesis' | 'grey';
  tier: 'triage' | 'standard' | 'strong';
  bodySafe: string;
  temperature: number;
  signal?: AbortSignal;
  responseSchema?: Record<string, unknown>;
  context?: {
    operations: { opId: string; type: string; evidence: string }[];
    localDate?: string;
    weekday?: string;
    evidenceMessageIds?: string[];
    categories?: { id: string; name: string }[];
    conversation?: { messageId: string; text: string }[];
    candidates?: { id: string; displayId: string; customer: string | null; summary: string }[];
  };
};

export type ModelPort = { generate: (request: ModelRequest) => Promise<string> };

export type EmbeddingPort = {
  embed: (input: {
    workspaceId?: string;
    text: string;
    task: 'document' | 'query';
  }) => Promise<number[]>;
};
