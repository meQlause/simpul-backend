import { beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import {
  app,
  cookie,
  pool,
  webhookApp,
  webhookSecret,
  draftWithVerification,
  setFixtureNow,
} from '../../../helpers/channel-activation.js';
import { coalesce } from '../../../../src/features/ingest/index.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';

let channelId: string;
let connectionId: string;
let workspaceId: string;
let chatId: number;
const when = new Date('2026-10-10T04:04:02Z');

beforeAll(async () => {
  const draft = await draftWithVerification('FR-TG-11 link group');
  const activation = await request(app)
    .post('/api/v1/channels/' + draft.channelId + '/activate')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'link-group-active')
    .send({
      verificationId: draft.verificationId,
      authorizationAck: true,
      expectedConfigVersion: 1,
    });

  expect(activation.status).toBe(200);
  channelId = draft.channelId;
  const row = (
    await pool.query(
      'SELECT workspace_id, bot_connection_id, provider_chat_id FROM channels WHERE id = $1',
      [channelId],
    )
  ).rows[0];

  workspaceId = row.workspace_id;
  connectionId = row.bot_connection_id;
  chatId = Number(row.provider_chat_id);

  // A person who holds the username but has written nothing yet.
  await addPerson('Andi Pratama', '@andi_sales', null, true);
  // Already linked to a Telegram id: a different account using the same name must not move it.
  await addPerson('Rina Linked', '@rina_linked', '6104', true);
  // A Telegram id that is linked to someone else: its username match must not link it again.
  await addPerson('Dedi Other', '@dedi_other', '6105', true);
  await addPerson('Eka Sales', '@eka_sales', null, true);
  // An inactive person keeps no link.
  await addPerson('Fira Gone', '@fira_gone', null, false);
});

async function addPerson(name: string, handle: string, externalId: string | null, active: boolean) {
  const person = await pool.query<{ id: string }>(
    'INSERT INTO people (workspace_id, name, active) VALUES ($1, $2, $3) RETURNING id',
    [workspaceId, name, active],
  );

  await pool.query(
    `INSERT INTO person_identities (workspace_id, person_id, provider, handle, external_id)
    VALUES ($1, $2, 'telegram', $3, $4)`,
    [workspaceId, person.rows[0].id, handle, externalId],
  );

  return person.rows[0].id;
}

async function send(from: { id: number; username?: string }, text: string, chat = chatId) {
  setFixtureNow(when);

  return request(webhookApp)
    .post('/api/v1/webhooks/telegram/' + connectionId)
    .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
    .send({
      update_id: 7000 + from.id,
      message: {
        message_id: from.id,
        date: when.getTime() / 1000,
        text,
        from: { ...from, is_bot: false },
        chat: { id: chat, title: 'FR-TG-11 link group', type: 'supergroup' },
      },
    });
}

async function linkedTo(externalId: string) {
  return (
    await pool.query<{ name: string | null }>(
      `SELECT person.name FROM person_identities AS identity
      JOIN people AS person ON person.id = identity.person_id
      WHERE identity.workspace_id = $1 AND identity.external_id = $2`,
      [workspaceId, externalId],
    )
  ).rows[0];
}

test('AC8: a message from the username of an unlinked person, in any letter case, links the sender and the unit is theirs', async () => {
  expect((await send({ id: 6101, username: 'Andi_Sales' }, 'pesanan ibu sri 3 dus')).status).toBe(
    200,
  );
  expect(await linkedTo('6101')).toEqual({ name: 'Andi Pratama' });

  await coalesce(
    {
      resolveConnection: createConnectionResolver(pool),
      now: () => new Date(when.getTime() + 29000),
      debounceSeconds: 12,
    },
    { workspaceId, channelId, senderExternalId: '6101' },
  );
  const unit = await pool.query(
    `SELECT person.name FROM units AS unit JOIN people AS person ON person.id = unit.sender_id
    WHERE unit.channel_id = $1 AND unit.text LIKE '%ibu sri%'`,
    [channelId],
  );

  expect(unit.rows).toEqual([{ name: 'Andi Pratama' }]);
});

test('AC8: an identity already linked keeps its Telegram id when another account uses the same username', async () => {
  await send({ id: 6102, username: 'rina_linked' }, 'halo');

  expect(await linkedTo('6104')).toEqual({ name: 'Rina Linked' });
  expect(await linkedTo('6102')).toBeUndefined();
});

test('AC8: a Telegram id already linked to another person is not linked again by a matching username', async () => {
  await send({ id: 6105, username: 'eka_sales' }, 'halo');

  expect(await linkedTo('6105')).toEqual({ name: 'Dedi Other' });
  expect(
    (await pool.query("SELECT external_id FROM person_identities WHERE handle = '@eka_sales'"))
      .rows,
  ).toEqual([{ external_id: null }]);
});

test('AC8: a sender without a username links nothing', async () => {
  await send({ id: 6106 }, 'halo');

  expect(await linkedTo('6106')).toBeUndefined();
});

test('AC8: an inactive person is not linked', async () => {
  await send({ id: 6107, username: 'fira_gone' }, 'halo');

  expect(await linkedTo('6107')).toBeUndefined();
});

test('AC8: a message in a chat that is not monitored links nothing', async () => {
  await send({ id: 6108, username: 'eka_sales' }, 'halo', -100999999);

  expect(await linkedTo('6108')).toBeUndefined();
});
