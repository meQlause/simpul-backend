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

const parseSetupUpdate: ReceiveProvider['parse'] = (update) => {
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

const incomingMessage = schema.object({
  update_id: schema.number().int().safe(),
  message: schema
    .object({
      message_id: schema.number().int().safe(),
      date: schema.number().int().positive(),
      text: schema.string().optional(),
      caption: schema.string().optional(),
      voice: schema
        .object({
          file_id: schema.string().min(1),
          mime_type: schema.string().default('audio/ogg'),
        })
        .optional(),
      from: schema.object({ id: schema.number().int().safe(), is_bot: schema.boolean() }),
      chat: schema.union([
        chat,
        schema.object({
          id: schema.number().int().safe().positive(),
          type: schema.literal('private'),
        }),
      ]),
    })
    .refine((message) => message.text !== undefined || message.voice !== undefined),
});

const callback = schema.object({
  update_id: schema.number().int().safe(),
  callback_query: schema.object({
    id: schema.string().min(1),
    data: schema.string(),
    from: schema.object({ id: schema.number().int().safe(), is_bot: schema.literal(false) }),
    message: schema.object({ chat: schema.object({ id: schema.number().int().safe() }) }),
  }),
});

function parseAction(update: unknown): ReturnType<ReceiveProvider['parse']> | undefined {
  const parsed = callback.safeParse(update);

  if (!parsed.success) {
    return undefined;
  }

  return {
    type: 'action',
    updateId: String(parsed.data.update_id),
    chatId: String(parsed.data.callback_query.message.chat.id),
    senderExternalId: String(parsed.data.callback_query.from.id),
    actionId: parsed.data.callback_query.data,
    receiptId: parsed.data.callback_query.id,
  };
}

export const parseInboundUpdate: ReceiveProvider['parse'] = (update) => {
  const action = parseAction(update);

  if (action) {
    return action;
  }

  const setup = parseSetupUpdate(update);

  if (setup.type === 'setup-command') {
    return setup;
  }

  const parsed = incomingMessage.safeParse(update);

  if (!parsed.success) {
    return setup;
  }

  const message = parsed.data.message;

  return {
    type: 'message',
    updateId: String(parsed.data.update_id),
    chatId: String(message.chat.id),
    messageId: String(message.message_id),
    senderExternalId: String(message.from.id),
    body: message.text ?? message.caption ?? '',
    ...(message.voice
      ? {
          mediaRef: JSON.stringify({
            fileId: message.voice.file_id,
            mimeType: message.voice.mime_type,
          }),
        }
      : {}),
    serverTs: message.date * MILLISECONDS_PER_SECOND,
    setupProof: setup.type === 'setup-message',
  };
};
