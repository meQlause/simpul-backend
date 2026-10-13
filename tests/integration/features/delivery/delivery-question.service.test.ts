import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { scopedTransaction } from '../../../../src/platform/db/scoped-transaction.js';
import { createSecretStore } from '../../../../src/platform/secrets/index.js';
import { createProviderRegistry } from '../../../../src/platform/providers/index.js';
import { createFakeProvider } from '../../../helpers/providers/fake.js';
import { sendQuestion } from '../../../../src/features/delivery/delivery-question.service.js';

const pool = databaseFixture();
const instant = new Date('2026-10-10T04:00:00Z');
const seed = pointStarSeed({ now: () => instant });
const exchange = vi.fn(async (_payload: unknown) => {});
const secretStore = createSecretStore(Buffer.alloc(32, 6).toString('base64'));
const minute = 60_000;
const send = vi.fn(async (_connection: unknown, _message: unknown) => ({
  providerMessageId: 'q-1',
}));
const plain = { ...createFakeProvider(exchange), provider: 'telegram' };
const inline = {
  ...plain,
  provider: 'telegram',
  capabilities: { ...plain.capabilities, inlineActions: true },
  send,
};
const threeCandidates = ['ORD-0091', 'ORD-0098', 'ORD-0095'];
let threads: string[] = [];
let units: string[] = [];
let channel = '';

function servicesWith(provider: typeof plain, now = instant) {
  return {
    resolveConnection: createConnectionResolver(pool),
    now: () => now,
    providers: createProviderRegistry([provider]),
    secretStore,
    publicBaseUrl: 'https://simpul.example',
  };
}

async function question(options: {
  unitId: string | null;
  candidates: string[];
  expiresAt: Date;
  answer?: string | null;
  channelId?: string;
}) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO open_questions (workspace_id, unit_id, channel_id, thread_ids, asked_at, expires_at, answer)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      seed.workspaceId,
      options.unitId,
      options.channelId ?? channel,
      options.candidates,
      instant,
      options.expiresAt,
      options.answer ?? null,
    ],
  );

  return rows[0].id;
}

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
  await scopedTransaction(createConnectionResolver(pool), seed.workspaceId, async (tx) => {
    const token = await secretStore.put(tx, seed.workspaceId, {
      purpose: 'bot_token',
      value: 'test-token',
    });

    await tx.query('UPDATE bot_connections SET token_secret_ref = $2 WHERE workspace_id = $1', [
      seed.workspaceId,
      token,
    ]);
  });
  threads = (
    await pool.query<{ id: string; display_id: string }>(
      'SELECT id, display_id FROM threads WHERE workspace_id = $1 AND display_id = ANY($2) ORDER BY display_id',
      [seed.workspaceId, threeCandidates],
    )
  ).rows.map((row) => row.id);
  units = (
    await pool.query<{ id: string }>(
      'SELECT id FROM units WHERE workspace_id = $1 ORDER BY ts_first LIMIT 8',
      [seed.workspaceId],
    )
  ).rows.map((row) => row.id);
  channel = (
    await pool.query<{ id: string }>(
      `SELECT id FROM channels WHERE workspace_id = $1 AND display_name = 'Sales & Order'`,
      [seed.workspaceId],
    )
  ).rows[0].id;
}, 120000);

beforeEach(async () => {
  vi.clearAllMocks();
  await pool.query('DELETE FROM open_questions WHERE workspace_id = $1', [seed.workspaceId]);
  await pool.query(
    `UPDATE channels SET connection_status = 'active', monitored = true WHERE id = $1`,
    [channel],
  );
});

test('SRS §6.7 (FR-UI-19): an inline provider gets the question with four numbered buttons and two sentences', async () => {
  expect(threads).toHaveLength(3);
  const questionId = await question({
    unitId: units[0] ?? null,
    candidates: threads,
    expiresAt: new Date(instant.getTime() + 10 * minute),
  });

  await sendQuestion(servicesWith(inline, new Date(instant.getTime() + minute)), {
    workspaceId: seed.workspaceId,
    questionId,
  });

  expect(send).toHaveBeenCalledOnce();
  const message = send.mock.calls[0]?.[1] as {
    kind: string;
    text: string;
    actions: { id: string; label: string }[];
  };

  expect(message.kind).toBe('question');
  expect(message.text).toContain('Which order did you mean?');
  expect(message.text).toContain('A question never creates a new work item.');
  expect(message.actions.map((action) => action.id)).toEqual([
    `q:${questionId}:1`,
    `q:${questionId}:2`,
    `q:${questionId}:3`,
    `q:${questionId}:4`,
  ]);
});

test('SRS §6.7 (FR-UI-19): a provider without buttons gets the four choices as a numbered list in the text', async () => {
  const questionId = await question({
    unitId: units[1] ?? null,
    candidates: threads,
    expiresAt: new Date(instant.getTime() + 10 * minute),
  });

  await sendQuestion(servicesWith(plain, new Date(instant.getTime() + minute)), {
    workspaceId: seed.workspaceId,
    questionId,
  });

  expect(exchange).toHaveBeenCalledOnce();
  const content = (exchange.mock.calls[0]?.[0] as { content: string }).content;

  expect(content).toMatch(/^1\. .+\n2\. .+\n3\. .+\n4\. None of these$/mu);
});

test('SRS §6.7 (FR-UI-19): a question that is answered, expired at its instant, or unanchored is not sent', async () => {
  const later = new Date(instant.getTime() + 10 * minute);
  const answered = await question({
    unitId: units[2] ?? null,
    candidates: threads,
    expiresAt: later,
    answer: 'none',
  });
  const expired = await question({
    unitId: units[3] ?? null,
    candidates: threads,
    expiresAt: later,
  });
  const unanchored = await question({ unitId: null, candidates: threads, expiresAt: later });
  const sending = servicesWith(inline, new Date(instant.getTime() + minute));
  const atExpiry = servicesWith(inline, later);

  await sendQuestion(sending, { workspaceId: seed.workspaceId, questionId: answered });
  await sendQuestion(atExpiry, { workspaceId: seed.workspaceId, questionId: expired });
  await sendQuestion(sending, { workspaceId: seed.workspaceId, questionId: unanchored });
  expect(send).not.toHaveBeenCalled();
});

test('SRS §6.7 (FR-UI-19): a question in a paused channel, or another workspace, is not sent', async () => {
  const later = new Date(instant.getTime() + 10 * minute);
  const sending = servicesWith(inline, new Date(instant.getTime() + minute));
  const paused = await question({
    unitId: units[4] ?? null,
    candidates: threads,
    expiresAt: later,
  });

  await pool.query(
    `UPDATE channels SET connection_status = 'paused', monitored = false WHERE id = $1`,
    [channel],
  );
  await sendQuestion(sending, { workspaceId: seed.workspaceId, questionId: paused });
  await pool.query(
    `UPDATE channels SET connection_status = 'active', monitored = true WHERE id = $1`,
    [channel],
  );
  expect(send).not.toHaveBeenCalled();

  const live = await question({ unitId: units[5] ?? null, candidates: threads, expiresAt: later });

  await sendQuestion(sending, {
    workspaceId: '00000000-0000-4000-8000-0000000007ff',
    questionId: live,
  });
  expect(send).not.toHaveBeenCalled();
});

test('SRS §8.4: a retry-after from the provider throws for queue backoff and writes nothing', async () => {
  const questionId = await question({
    unitId: units[6] ?? null,
    candidates: threads,
    expiresAt: new Date(instant.getTime() + 10 * minute),
  });

  send.mockResolvedValueOnce({ retryAfter: 30 } as never);

  await expect(
    sendQuestion(servicesWith(inline, new Date(instant.getTime() + minute)), {
      workspaceId: seed.workspaceId,
      questionId,
    }),
  ).rejects.toMatchObject({ code: 'E-INTERNAL', retryAfter: 30 });
  expect(
    (await pool.query('SELECT answer FROM open_questions WHERE id = $1', [questionId])).rows,
  ).toEqual([{ answer: null }]);
});
