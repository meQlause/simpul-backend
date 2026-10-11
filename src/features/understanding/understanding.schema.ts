import { z } from 'zod';

export const triageClass = z.enum(['EVENT', 'QUERY', 'NOISE']);

export const queryPayload = z.strictObject({ workspaceId: z.guid(), unitId: z.guid() });

export const comprehensionScope = queryPayload.extend({ threadId: z.guid() });

export const comprehensionOutput = z.strictObject({
  operations: z.array(
    z.strictObject({
      type: z.enum(['progress', 'resolution', 'blocker']),
      tense: z.enum(['sudah_terjadi', 'rencana', 'kondisional']),
      evidenceMessageIds: z.array(z.guid()),
      confidence: z.number().min(0).max(1),
      retractsOpId: z.guid().nullable().optional(),
    }),
  ),
});

export const candidatesInput = z.strictObject({
  quantity: z.number().finite().nullable(),
  candidates: z.array(
    z.strictObject({
      id: z.guid(),
      score: z.number().min(0).max(1),
      quantity: z.number().finite().nullable(),
    }),
  ),
});
