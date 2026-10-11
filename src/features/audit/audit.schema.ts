import { z as zod } from 'zod';

const namedPerson = zod.object({ id: zod.guid(), name: zod.string() });
const role = namedPerson.extend({ team: zod.string() });

export const configAuditSchemas = {
  vocab_domains: zod
    .object({
      id: zod.guid(),
      name: zod.string(),
      description: zod.string().nullable(),
      example: zod.string().nullable(),
      idPrefix: zod.string().nullable(),
      prefixInUse: zod.boolean(),
    })
    .partial(),
  aliases: zod.object({ id: zod.guid(), alias: zod.string(), person: namedPerson }).partial(),
  channels: zod
    .object({
      botConnectionId: zod.guid(),
      providerChatId: zod.string(),
      displayName: zod.string(),
      class: zod.string(),
      primaryLanguage: zod.string(),
      connectionStatus: zod.string(),
      monitored: zod.boolean(),
    })
    .partial(),
  bot_connections: zod
    .object({
      connectionName: zod.string(),
      providerAccountId: zod.string(),
      credentialVersion: zod.number().int().positive(),
      status: zod.string(),
    })
    .partial(),
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
