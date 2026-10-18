import { expect, test, vi } from 'vitest';
import { createTelegramProvider } from '../../../../../src/platform/providers/telegram/index.js';
import { parseInboundUpdate } from '../../../../../src/platform/providers/telegram/receive.js';

test('FR-UI-03: private numbered replies retain the authenticated provider actor', () => {
  expect(
    parseInboundUpdate({
      update_id: 1,
      message: {
        message_id: 2,
        date: 1700000000,
        text: '1 ORD-0091',
        from: { id: 12, is_bot: false },
        chat: { id: 12, type: 'private' },
      },
    }),
  ).toMatchObject({ type: 'message', chatId: '12', senderExternalId: '12', body: '1 ORD-0091' });
});

test('FR-UI-03: inline callback data is a neutral action with a provider-bound actor', () => {
  expect(
    parseInboundUpdate({
      update_id: 3,
      callback_query: {
        id: 'receipt',
        data: 'n:11111111-1111-4111-8111-111111111111:r',
        from: { id: 12, is_bot: false },
        message: { message_id: 2, chat: { id: 12, type: 'private' } },
      },
    }),
  ).toEqual({
    type: 'action',
    updateId: '3',
    chatId: '12',
    senderExternalId: '12',
    actionId: 'n:11111111-1111-4111-8111-111111111111:r',
    receiptId: 'receipt',
  });
});

test('FR-UI-03: callback acknowledgement clears the provider interaction without business text', async () => {
  const send = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true })));
  const adapter = createTelegramProvider('https://api.telegram.org', send);

  expect(adapter.acknowledgeAction).toBeTypeOf('function');
  await adapter.acknowledgeAction?.({ credential: 'test-token' }, 'receipt');

  expect(send).toHaveBeenCalledWith(
    'https://api.telegram.org/bottest-token/answerCallbackQuery',
    expect.objectContaining({ body: JSON.stringify({ callback_query_id: 'receipt' }) }),
  );
});

test('FR-TG-11: a Telegram username is kept as senderHandle, and absent when the sender has none', () => {
  const message = {
    update_id: 5,
    message: {
      message_id: 6,
      date: 1700000000,
      text: 'halo',
      from: { id: 13, is_bot: false, username: 'Andi_Sales' },
      chat: { id: 13, type: 'private' },
    },
  };

  expect(parseInboundUpdate(message)).toMatchObject({
    type: 'message',
    senderExternalId: '13',
    senderHandle: 'Andi_Sales',
  });
  expect(
    parseInboundUpdate({
      ...message,
      message: { ...message.message, from: { id: 13, is_bot: false } },
    }),
  ).not.toHaveProperty('senderHandle');
});

function privateText(text: string, from: object = { id: 77, is_bot: false, username: 'Budi_S' }) {
  return {
    update_id: 9,
    message: { message_id: 3, date: 1700000000, text, from, chat: { id: 77, type: 'private' } },
  };
}

test('FR-TG-12: a private /start, with or without an invite code, is person-start', () => {
  const code = 'a'.repeat(32);

  expect(parseInboundUpdate(privateText(`/start ${code}`))).toEqual({
    type: 'person-start',
    updateId: '9',
    chatId: '77',
    senderExternalId: '77',
    senderHandle: 'Budi_S',
    code,
  });
  expect(parseInboundUpdate(privateText('/start', { id: 77, is_bot: false }))).toEqual({
    type: 'person-start',
    updateId: '9',
    chatId: '77',
    senderExternalId: '77',
  });
});

test('FR-TG-12: a group /start, a bot sender, another argument or plain text is not person-start', () => {
  const group = {
    update_id: 9,
    message: {
      message_id: 3,
      date: 1700000000,
      text: '/start',
      from: { id: 77, is_bot: false },
      chat: { id: -100, type: 'group', title: 'Ops' },
    },
  };

  for (const update of [
    group,
    privateText('/start', { id: 77, is_bot: true }),
    privateText('/start hello'),
    privateText(`/start ${'A'.repeat(32)}`),
    privateText('hello'),
  ]) {
    expect(parseInboundUpdate(update).type).not.toBe('person-start');
  }
});
