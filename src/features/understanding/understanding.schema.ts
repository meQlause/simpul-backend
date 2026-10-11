import { z } from 'zod';

export const queryPayload = z.strictObject({ workspaceId: z.guid(), unitId: z.guid() });
