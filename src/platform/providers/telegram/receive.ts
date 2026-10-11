import { z as schema } from 'zod';
import type { ReceiveProvider } from '../contract.js';

const MILLISECONDS_PER_SECOND = 1000;

const chat = schema.object({
  id: schema.number().int().safe().negative(),
  title: schema.string(),
  type: schema.enum(['group', 'supergroup']),
});
const command = schema.object({
  message: schema.object({
    text: schema.string().regex(/^\/simpul_connect(?:@\w+)? [0-9a-f]{32}$/u),
    chat,
  }),
});
const ordinary = schema.object({
  message: schema
    .object({
      text: schema
        .string()
        .trim()
        .min(1)
        .regex(/^(?!\/)/u),
      date: schema.number().int().positive(),
      from: schema.object({ is_bot: schema.literal(false) }),
      chat,
      entities: schema.array(schema.object({ type: schema.string() })).optional(),
    })
    .refine((message) => !(message.entities ?? []).some((entity) => entity.type === 'bot_command')),
});

export const parseSetupUpdate: ReceiveProvider['parse'] = (update) => {
  const parsed = command.safeParse(update);

  if (parsed.success) {
    const message = parsed.data.message;

    return {
      type: 'setup-command',
      code: message.text.split(' ')[1],
      chatId: String(message.chat.id),
      title: message.chat.title,
      chatType: message.chat.type,
    };
  }

  const incoming = ordinary.safeParse(update);

  if (!incoming.success) {
    return { type: 'ignore' };
  }

  return {
    type: 'setup-message',
    chatId: String(incoming.data.message.chat.id),
    sentAt: incoming.data.message.date * MILLISECONDS_PER_SECOND,
  };
};
