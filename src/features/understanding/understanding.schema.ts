import { z } from 'zod';

export const triageClass = z.enum(['EVENT', 'QUERY', 'NOISE']);

export const queryPayload = z.strictObject({ workspaceId: z.guid(), unitId: z.guid() });

export const comprehensionScope = queryPayload.extend({ threadId: z.guid() });

export const comprehensionJobScope = queryPayload.extend({ threadId: z.guid().nullable() });

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
      reference: z.boolean().default(false),
    }),
  ),
});

export const genesisOutput = z.strictObject({
  genesis: z
    .strictObject({
      domainId: z.guid(),
      intent: z.enum(['work_request', 'work_event', 'status_query', 'ack', 'noise']),
      tense: z.enum(['sudah_terjadi', 'rencana', 'kondisional']),
      who: z.string().trim().min(1).nullable(),
      what: z.string().trim().min(1).nullable(),
      action: z.string().trim().min(1).nullable(),
      completionCondition: z.string().trim().min(1).nullable(),
      summary: z.string().trim().min(1),
      confidence: z.number().min(0).max(1),
      evidenceMessageIds: z.array(z.guid()).min(1),
    })
    .nullable(),
  operations: comprehensionOutput.shape.operations,
});

export const greyOutput = z.strictObject({
  choice: z.enum(['candidate', 'new_work', 'not_sure']),
  threadId: z.guid().nullable(),
  supportingMessageIds: z.array(z.guid()),
});
