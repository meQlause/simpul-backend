import { z as zod } from 'zod';

export const createWorkspaceSchema = zod
  .object({
    name: zod.string().trim().min(1).max(80),
    'admin-name': zod.string().trim().min(1).max(120),
    'admin-email': zod.string().trim().toLowerCase().pipe(zod.email()),
    timezone: zod
      .string()
      .trim()
      .min(1)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }),
  })
  .strict();
