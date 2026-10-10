import { z as zod } from 'zod';

const namedPerson = zod.object({ id: zod.guid(), name: zod.string() });
const role = namedPerson.extend({ team: zod.string() });

export const configAuditSchemas = {
  workspaces: zod
    .object({
      name: zod.string(),
      timezone: zod.string(),
      descriptor: zod.string().nullable(),
      adminPersonId: zod.guid(),
    })
    .partial(),
  policies: zod
    .object({
      quietStart: zod.string(),
      quietEnd: zod.string(),
      budgetPerHour: zod.number(),
      digestTime: zod.string(),
      holdSeconds: zod.number(),
      timezone: zod.string(),
    })
    .partial(),
  people: zod
    .object({
      id: zod.guid(),
      name: zod.string(),
      level: zod.string(),
      availability: zod.string(),
      identities: zod.array(
        zod.object({ provider: zod.string(), handle: zod.string().nullable() }),
      ),
      role: role.nullable(),
      manager: namedPerson.nullable(),
      backup: namedPerson.nullable(),
    })
    .partial(),
  mail_connections: zod
    .object({
      host: zod.string(),
      port: zod.number(),
      username: zod.string(),
      fromAddress: zod.string(),
    })
    .partial(),
} as const;
