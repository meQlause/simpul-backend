import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { scopedTransaction } from '../../../../src/platform/db/scoped-transaction.js';
import { receiveRecipientAction } from '../../../../src/features/delivery/delivery-action.service.js';
import { recipientActionTarget } from '../../../../src/features/delivery/delivery-action.repository.js';
import { answerClarification } from '../../../../src/features/understanding/understanding-answer.service.js';

const pool = databaseFixture();
const instant = new Date('2026-10-10T04:00:00Z');
const seed = pointStarSeed({ now: () => instant });
const minute = 60_000;
const chatId = '-100240000002';
const budiExternalId = '4444';
const resolve = createConnectionResolver(pool);
const publishComprehend = vi.fn(async (_tx: unknown, _payload: unknown) => undefined);
const scope = { workspaceId: seed.workspaceId, connectionId: seed.botId, provider: 'telegram' };
let budiPerson = '';
let channel = '';
let threads: string[] = [];
let units: string[] = [];

async function question(
  unitIndex: number,
  expiresAt: Date,
  answer: string | null = null,
  unitless = false,
) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO open_questions (workspace_id, unit_id, channel_id, thread_ids, asked_at, expires_at, answer)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      seed.workspaceId,
      unitless ? null : units[unitIndex],
      channel,
      threads,
      instant,
      expiresAt,
      answer,
    ],
  );

  return rows[0].id;
}

const later = () => new Date(instant.getTime() + 10 * minute);

// The provider's callback for a button, and the plain text reply the same person may send instead.
const callback = (updateId: string, questionId: string, choice: number) => ({
  type: 'action' as const,
  updateId,
  chatId,
  senderExternalId: budiExternalId,
  actionId: `q:${questionId}:${choice}`,
});
const text = (updateId: string, body: string, from = budiExternalId, chat = chatId) => ({
  type: 'message' as const,
  updateId,
  chatId: chat,
  messageId: `msg-${updateId}`,
  senderExternalId: from,
  body,
  serverTs: instant.getTime(),
  setupProof: false,
});

function run(
  event: ReturnType<typeof callback> | ReturnType<typeof text>,
  now: Date,
  claimed = true,
) {
  const services = {
    now,
    claimUpdate: async () => claimed,
    answerQuestion: (
      tx: Parameters<typeof answerClarification>[0],
      input: Parameters<typeof answerClarification>[1],
    ) => answerClarification(tx, input, { now, publishComprehend }),
  };

  return scopedTransaction(resolve, seed.workspaceId, (tx) =>
    receiveRecipientAction(tx, scope, event, services),
  );
}

const answerOf = async (questionId: string) =>
  (await pool.query('SELECT answer, answered_by FROM open_questions WHERE id = $1', [questionId]))
    .rows[0];

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
  await pool.query(
    `UPDATE person_identities SET external_id = $2 WHERE workspace_id = $1 AND person_id = md5('point-star-person-2')::uuid`,
    [seed.workspaceId, budiExternalId],
  );
  budiPerson = (await pool.query<{ id: string }>(`SELECT md5('point-star-person-2')::uuid AS id`))
    .rows[0].id;
  channel = (
    await pool.query<{ id: string }>(
      `SELECT id FROM channels WHERE workspace_id = $1 AND provider_chat_id = $2`,
      [seed.workspaceId, chatId],
    )
  ).rows[0].id;
  threads = (
    await pool.query<{ id: string }>(
      `SELECT id FROM threads WHERE workspace_id = $1 AND display_id = ANY($2) ORDER BY display_id`,
      [seed.workspaceId, ['ORD-0091', 'ORD-0098', 'ORD-0095']],
    )
  ).rows.map((row) => row.id);
  units = (
    await pool.query<{ id: string }>(
      'SELECT id FROM units WHERE workspace_id = $1 ORDER BY ts_first LIMIT 8',
      [seed.workspaceId],
    )
  ).rows.map((row) => row.id);
}, 120000);

beforeEach(async () => {
  vi.clearAllMocks();
  await pool.query('DELETE FROM open_questions WHERE workspace_id = $1', [seed.workspaceId]);
});

test('SRS §6.7 (FR-RES-02): a button answer picks the second candidate once; the same update does not publish again', async () => {
  expect(threads).toHaveLength(3);
  const questionId = await question(0, later());

  expect(await run(callback('upd-1', questionId, 2), new Date(instant.getTime() + minute))).toBe(
    true,
  );
  expect(await answerOf(questionId)).toEqual({ answer: threads[1], answered_by: budiPerson });
  expect(publishComprehend).toHaveBeenCalledOnce();
  expect(publishComprehend.mock.calls[0]?.[1]).toEqual({
    workspaceId: seed.workspaceId,
    unitId: units[0],
    threadId: threads[1],
  });

  expect(
    await run(callback('upd-1', questionId, 2), new Date(instant.getTime() + minute), false),
  ).toBe(false);
  expect(publishComprehend).toHaveBeenCalledOnce();
});

test('SRS §6.7 (FR-RES-02): the number "4" with three candidates answers none, with no label, notification or publish', async () => {
  const questionId = await question(1, later());

  expect(await run(text('upd-4', '4'), new Date(instant.getTime() + minute))).toBe(true);
  expect(await answerOf(questionId)).toEqual({ answer: 'none', answered_by: budiPerson });
  expect(publishComprehend).not.toHaveBeenCalled();
  expect(
    (await pool.query('SELECT count(*)::int AS n FROM labels WHERE unit_id = $1', [units[1]]))
      .rows[0]?.n,
  ).toBe(0);
});

test('SRS §6.7 (FR-RES-02, D10): an answer is refused at or after the expiry, but accepted one second before', async () => {
  const expires = new Date(instant.getTime() + 10 * minute);
  const late = await question(2, expires);
  const exact = await question(3, expires);
  const early = await question(4, expires);

  expect(await run(callback('upd-late', late, 1), new Date(expires.getTime() + 1000))).toBe(false);
  expect(await run(callback('upd-exact', exact, 1), expires)).toBe(false);
  expect(await run(callback('upd-early', early, 1), new Date(expires.getTime() - 1000))).toBe(true);

  expect((await answerOf(late)).answer).toBeNull();
  expect((await answerOf(exact)).answer).toBeNull();
  expect((await answerOf(early)).answer).toBe(threads[0]);
  expect(publishComprehend).toHaveBeenCalledOnce();
});

test('SRS §6.7 (FR-RES-02): an unknown sender, another chat, a question without a unit, choice 5 and a second answer change nothing', async () => {
  const open = await question(5, later());
  const unanchored = await question(0, later(), null, true);
  const now = new Date(instant.getTime() + minute);

  expect(await run(text('upd-stranger', '1', 'nobody'), now)).toBe(false);
  expect(await run(text('upd-other-chat', '1', budiExternalId, '-100999'), now)).toBe(false);
  expect(await run(callback('upd-unanchored', unanchored, 1), now)).toBe(false);
  expect(await run(callback('upd-five', open, 5), now)).toBe(false);

  expect((await answerOf(open)).answer).toBeNull();
  expect((await answerOf(unanchored)).answer).toBeNull();
  expect(publishComprehend).not.toHaveBeenCalled();

  expect(await run(callback('upd-first', open, 1), now)).toBe(true);
  expect(await run(callback('upd-second', open, 2), now)).toBe(false);
  expect((await answerOf(open)).answer).toBe(threads[0]);
  expect(publishComprehend).toHaveBeenCalledOnce();
});

test('SRS §6.7 (FR-RES-02): another connection, or an inactive person, cannot answer the question', async () => {
  const open = await question(6, later());
  const now = new Date(instant.getTime() + minute);
  const otherConnection = { ...scope, connectionId: '00000000-0000-4000-8000-0000000000ff' };
  const services = { now, claimUpdate: async () => true, answerQuestion: async () => undefined };

  expect(
    await scopedTransaction(resolve, seed.workspaceId, (tx) =>
      receiveRecipientAction(tx, otherConnection, text('upd-other-bot', '1'), services),
    ),
  ).toBe(false);

  await pool.query('UPDATE people SET active = false WHERE id = $1', [budiPerson]);
  expect(await run(callback('upd-inactive', open, 1), now)).toBe(false);
  await pool.query('UPDATE people SET active = true WHERE id = $1', [budiPerson]);

  expect((await answerOf(open)).answer).toBeNull();
  expect(publishComprehend).not.toHaveBeenCalled();
});

test('SRS §6.7 (D10): a reply that is both an answer and a status is neither, and the message is stored', async () => {
  const open = await question(7, later());
  const now = new Date(instant.getTime() + minute);

  // A sent reminder to Budi in this chat, about a thread of this chat: a reply "1" is a status too.
  await pool.query(
    `INSERT INTO notifications (workspace_id, label_id, thread_id, recipient_person_id, channel, body_rendered, held_until, sent_at, kind, destination_channel_id, stale_since, created_at)
     SELECT $1, NULL, t.id, NULL, 'telegram', 'Reminder', $2, $2, 'reminder', $3, t.last_activity_at, $2
     FROM threads t WHERE t.workspace_id = $1 AND t.display_id = 'ORD-0091'`,
    [seed.workspaceId, instant, channel],
  );
  const status = await scopedTransaction(resolve, seed.workspaceId, (tx) =>
    recipientActionTarget(tx, scope, text('upd-both', '1'), {
      displayId: undefined,
      notificationId: undefined,
    }),
  );

  expect(status).toBeDefined();

  expect(await run(text('upd-both', '1'), now)).toBe(false);
  expect((await answerOf(open)).answer).toBeNull();
  expect(publishComprehend).not.toHaveBeenCalled();
});
