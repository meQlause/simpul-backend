import { z as schema } from 'zod';
import { DomainError } from '../../errors/domain-error.js';
import type { ActivationProvider, ConnectionRef, Limits, ReadinessCheck } from '../contract.js';
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

const SECOND_MS = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTE_MS = SECONDS_PER_MINUTE * SECOND_MS;

function createSendLimiter(limits: Limits) {
  // ponytail: this process-local window is sufficient for the single VPS sender; use shared
  // storage if delivery workers are scaled across processes.
  const sentByKey = new Map<string, number[]>();

  function recent(key: string, now: number, windowMs: number) {
    const sent = (sentByKey.get(key) ?? []).filter((time) => now - time < windowMs);

    sentByKey.set(key, sent);

    return sent;
  }

  async function waitForSlot(providerAccountId: string, chatId: string) {
    const accountKey = `account:${providerAccountId}`;
    const chatKey = `chat:${providerAccountId}:${chatId}`;

    while (true) {
      const now = Date.now();
      const accountSent = recent(accountKey, now, SECOND_MS);
      const chatSent = recent(chatKey, now, MINUTE_MS);
      const accountWait =
        accountSent.length >= limits.sendPerSecond ? accountSent[0]! + SECOND_MS - now : 0;
      const chatWait =
        chatSent.length >= limits.sendPerChatPerMinute ? chatSent[0]! + MINUTE_MS - now : 0;

      if (accountWait === 0 && chatWait === 0) {
        accountSent.push(now);
        chatSent.push(now);

        return;
      }

      await new Promise((resolve) => setTimeout(resolve, Math.max(accountWait, chatWait)));
    }
  }

  return waitForSlot;
}

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

const FORBIDDEN_STATUS = 403;
const BAD_REQUEST_STATUS = 400;
const refusal = schema.object({
  ok: schema.literal(false),
  error_code: schema.number(),
  description: schema.string().default(''),
});

// FR-TG-13: 403 (blocked, or never started) and a chat Telegram cannot find mean the person cannot
// be reached; any other refusal is the send failing, as before.
function refusedSend(data: unknown): { unreachable: true } {
  const parsed = refusal.safeParse(data);
  const reason = parsed.success ? parsed.data : undefined;

  if (
    reason?.error_code === FORBIDDEN_STATUS ||
    (reason?.error_code === BAD_REQUEST_STATUS &&
      /chat not found|PEER_ID_INVALID/u.test(reason.description))
  ) {
    return { unreachable: true };
  }

  throw new DomainError('E-TG-ACTIVATION-FAILED');
}

async function sendMessage(
  call: Call,
  connection: ConnectionRef,
  message: Parameters<ActivationProvider['send']>[1],
): ReturnType<ActivationProvider['send']> {
  try {
    const data = await call(connection.credential, 'sendMessage', outboundBody(message));
    const result = schema
      .object({
        ok: schema.literal(true),
        result: schema.object({ message_id: schema.number().int().safe() }),
      })
      .safeParse(data);

    if (!result.success) {
      return refusedSend(data);
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
  limits: Limits,
): Pick<ActivationProvider, 'describeChat' | 'checkReadiness' | 'send'> {
  const waitForSendSlot = createSendLimiter(limits);

  return {
    describeChat: (connection, chatId) => describeChat(call, connection, chatId),
    checkReadiness: (connection, chatId) => checkReadiness(call, verify, connection, chatId),
    async send(connection, message) {
      await waitForSendSlot(connection.providerAccountId, message.chatId);

      return sendMessage(call, connection, message);
    },
  };
}
