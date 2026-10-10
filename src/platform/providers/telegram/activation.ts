import { z as schema } from 'zod';
import { DomainError } from '../../errors/domain-error.js';
import type { ActivationProvider, ConnectionRef, ReadinessCheck } from '../contract.js';
import type { createCall } from './call.js';

type Call = ReturnType<typeof createCall>;
const chatSchema = schema.object({
  ok: schema.literal(true),
  result: schema.object({
    type: schema.enum(['group', 'supergroup', 'private', 'channel']),
    title: schema.string().optional(),
  }),
});
const memberSchema = schema.object({
  ok: schema.literal(true),
  result: schema.object({
    status: schema.enum(['creator', 'administrator', 'member', 'restricted', 'left', 'kicked']),
    is_member: schema.boolean().optional(),
    can_send_messages: schema.boolean().optional(),
  }),
});

async function describeChat(call: Call, connection: ConnectionRef, chatId: string) {
  const result = chatSchema.safeParse(
    await call(connection.credential, 'getChat', { chat_id: chatId }),
  );
  if (!result.success) {
    throw new DomainError('E-TG-GROUP-UNAVAILABLE');
  }
  const chat = result.data.result;
  if (chat.type === 'private' || chat.type === 'channel') {
    throw new DomainError('E-TG-CHAT-TYPE-UNSUPPORTED');
  }
  return { chatType: chat.type, title: chat.title ?? '' };
}

function check(key: string, pass: boolean, message: string): ReadinessCheck {
  return { key, status: pass ? 'pass' : 'fail', message, action: pass ? null : message };
}

function canSend(member: { status: string; is_member?: boolean; can_send_messages?: boolean }) {
  return (
    member.status !== 'restricted' ||
    (member.is_member === true && member.can_send_messages === true)
  );
}

async function checkReadiness(
  call: Call,
  verify: ActivationProvider['verifyCredential'],
  connection: ConnectionRef,
  chatId: string,
) {
  const account = await verify(connection.credential);
  await describeChat(call, connection, chatId);
  const member = memberSchema.safeParse(
    await call(connection.credential, 'getChatMember', {
      chat_id: chatId,
      user_id: Number(account.providerAccountId),
    }),
  );
  if (!member.success || ['left', 'kicked'].includes(member.data.result.status)) {
    throw new DomainError('E-TG-GROUP-UNAVAILABLE');
  }
  const hook = schema
    .object({ ok: schema.literal(true), result: schema.object({ url: schema.string() }) })
    .safeParse(await call(connection.credential, 'getWebhookInfo'));
  if (!hook.success) {
    throw new DomainError('E-TG-TOKEN-INVALID');
  }
  if (hook.data.result.url !== '' && hook.data.result.url !== connection.webhookUrl) {
    throw new DomainError('E-TG-WEBHOOK-CONFLICT');
  }
  const available = canSend(member.data.result);
  return [
    check(
      'bot_identity',
      account.providerAccountId === connection.providerAccountId,
      'Verified bot matches the workspace connection',
    ),
    check('group', true, 'Confirmed Telegram group or supergroup'),
    check('membership', available, 'No administrator rights required for ordinary message access'),
    check(
      'privacy_mode',
      account.privacyModeOk && account.canJoinGroups,
      'Disable privacy mode in BotFather; re-add the bot if needed',
    ),
    check(
      'webhook',
      hook.data.result.url === connection.webhookUrl,
      'Dedicated Simpul webhook; never overwrite another application',
    ),
  ];
}

function outboundBody(message: Parameters<ActivationProvider['send']>[1]) {
  return {
    chat_id: message.chatId,
    text: message.text,
    ...(message.actions?.length
      ? {
          reply_markup: {
            inline_keyboard: message.actions.map((action) => [
              { text: action.label, callback_data: action.id },
            ]),
          },
        }
      : {}),
    ...(message.replyToMessageId === undefined
      ? {}
      : { reply_parameters: { message_id: Number(message.replyToMessageId) } }),
  };
}

async function sendMessage(
  call: Call,
  connection: ConnectionRef,
  message: Parameters<ActivationProvider['send']>[1],
): ReturnType<ActivationProvider['send']> {
  try {
    const result = schema
      .object({
        ok: schema.literal(true),
        result: schema.object({ message_id: schema.number().int().safe() }),
      })
      .safeParse(await call(connection.credential, 'sendMessage', outboundBody(message)));
    if (!result.success) {
      throw new DomainError('E-TG-ACTIVATION-FAILED');
    }
    return { providerMessageId: String(result.data.result.message_id) };
  } catch (error) {
    if (
      error instanceof DomainError &&
      error.code === 'E-TG-RATE-LIMITED' &&
      error.retryAfter !== undefined
    ) {
      return { retryAfter: error.retryAfter };
    }
    throw error;
  }
}

export function activationMethods(
  call: Call,
  verify: ActivationProvider['verifyCredential'],
): Pick<ActivationProvider, 'describeChat' | 'checkReadiness' | 'send'> {
  return {
    describeChat: (connection, chatId) => describeChat(call, connection, chatId),
    checkReadiness: (connection, chatId) => checkReadiness(call, verify, connection, chatId),
    send: (connection, message) => sendMessage(call, connection, message),
  };
}
