import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import {
  databaseFixture,
  seedConnectionRoutes,
  createConnectionResolver,
  createConnectionLookup,
} from '../helpers/database-mode.js';
import { applyMigrations } from '../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../fixtures/point-star.js';
import { createFakeProvider } from '../helpers/providers/fake.js';
import { createProviderRegistry } from '../../src/platform/providers/index.js';
import { createSecretStore } from '../../src/platform/secrets/index.js';
import {
  createQueue,
  publishCoalesce,
  publishNotification,
} from '../../src/platform/queue/index.js';
import { webhookRouter } from '../../src/features/ingest/index.js';
import { registerPipelineJobs } from '../../src/roles/worker.js';
import { errorHandler } from '../../src/platform/http/error-handler.js';
import type { ModelPort } from '../../src/platform/llm/port.js';

const pool = databaseFixture(3);
const instant = new Date('2026-10-10T04:00:00Z');
const seed = pointStarSeed({ now: () => instant });
const exchange = vi.fn(async (_payload: unknown) => {});
const adapter = createFakeProvider(exchange);
const secretStore = createSecretStore(Buffer.alloc(32, 5).toString('base64'));
const services = {
  resolveConnection: createConnectionResolver(pool),
  now: () => new Date(instant.getTime() + 12000),
  secretStore,
  providers: createProviderRegistry([adapter]),
  publicBaseUrl: 'https://simpul.example',
  transcriber: { transcribe: vi.fn(async () => '') },
};
const model: ModelPort = {
  generate: vi.fn(async (input: Parameters<ModelPort['generate']>[0]) => {
    if (input.mode === 'triage') {
      return 'EVENT';
    }

    if (input.mode === 'genesis') {
      return JSON.stringify(genesisResponse(input));
    }

    return JSON.stringify({
      operations: [
        {
          type: 'progress',
          tense: 'sudah_terjadi',
          confidence: 0.9,
          evidenceMessageIds: input.context?.evidenceMessageIds ?? [],
        },
      ],
    });
  }),
};

function genesisResponse(input: Parameters<ModelPort['generate']>[0]) {
  return {
    genesis: {
      domainId: input.context?.categories?.find((category) => category.name === 'Order')?.id,
      intent: 'work_request',
      tense: 'sudah_terjadi',
      who: 'Lakeview',
      what: 'cobalt binders',
      action: 'ordered',
      completionCondition: 'Collected',
      summary: 'Lakeview cobalt binders order',
      confidence: 0.9,
      evidenceMessageIds: input.context?.evidenceMessageIds ?? [],
    },
    operations: [
      {
        type: 'progress',
        tense: 'sudah_terjadi',
        confidence: 0.9,
        evidenceMessageIds: input.context?.evidenceMessageIds ?? [],
      },
    ],
  };
}

let queue: Awaited<ReturnType<typeof createQueue>>;
let source: { id: string; connectionId: string };

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
  queue = await createQueue(pool);
  source = (
    await pool.query(
      'SELECT id, bot_connection_id AS "connectionId" FROM channels WHERE id = md5(\'point-star-channel-2\')::uuid',
    )
  ).rows[0];
  await configureProvider();
  await seedConnectionRoutes(pool);
  await pool.query('UPDATE policies SET hold_seconds = 0 WHERE workspace_id = $1', [
    seed.workspaceId,
  ]);
  await registerPipelineJobs(queue, {
    ...services,
    model,
    debounceSeconds: 0,
    embedding: {
      embed: async () => Array.from({ length: 768 }, (_item, index) => (index === 0 ? 1 : 0)),
    },
    embeddingModel: 'embedding-model',
    audit: vi.fn(),
    alert: vi.fn(),
  });
}, 120000);
afterAll(async () => {
  await queue?.stop();
});

async function configureProvider() {
  const tx = await pool.connect();

  try {
    const token = await secretStore.put(tx, seed.workspaceId, {
      purpose: 'bot_token',
      value: 'fake-token',
    });
    const secret = await secretStore.put(tx, seed.workspaceId, {
      purpose: 'webhook_secret',
      value: 'fake-secret',
    });

    await tx.query(
      "UPDATE bot_connections SET provider = 'fake', token_secret_ref = $2, webhook_secret_ref = $3 WHERE id = $1",
      [source.connectionId, token, secret],
    );
    await tx.query(
      "UPDATE channels SET provider = 'fake', provider_chat_id = 'fake-room' WHERE id = $1",
      [source.id],
    );
    await tx.query("UPDATE person_identities SET provider = 'fake' WHERE workspace_id = $1", [
      seed.workspaceId,
    ]);
  } finally {
    tx.release();
  }
}

test('REG-010 / NFR-AD-05: the live workers coalesce, understand, route and send a fake-provider webhook', async () => {
  const receiver = express()
    .use(
      webhookRouter({
        ...services,
        lookupConnection: createConnectionLookup(pool),
        publish: publishCoalesce(queue, 0),
      }),
    )
    .use(errorHandler);
  const response = await request(receiver)
    .post(`/api/v1/webhooks/fake/${source.connectionId}`)
    .set('X-Fake-Secret', 'fake-secret')
    .send({
      eventId: 'pipeline-update',
      room: 'fake-room',
      messageId: 'pipeline-message',
      author: 'fake-person',
      content: 'ORD-0091: the shipment is moving.',
      sentAt: instant.getTime(),
    });

  expect(response.status).toBe(200);
  const notifications = await vi.waitFor(
    async () => {
      const rows = (
        await pool.query(
          'SELECT n.channel, n.sent_at FROM notifications n JOIN labels l ON l.id = n.label_id JOIN unit_messages um ON um.unit_id = l.unit_id JOIN messages_raw m ON m.id = um.message_id WHERE m.provider_msg_id = $1',
          ['pipeline-message'],
        )
      ).rows;

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.sent_at instanceof Date)).toBe(true);

      return rows;
    },
    { timeout: 15000 },
  );

  expect(notifications.length).toBeGreaterThan(0);
  expect(notifications.every((row) => row.channel === 'fake' && row.sent_at instanceof Date)).toBe(
    true,
  );
  expect(exchange).toHaveBeenCalledTimes(notifications.length);
  expect(
    exchange.mock.calls.every(([payload]) =>
      (payload as { content: string }).content.includes(
        '1. Already shipped\n2. In progress\n3. There is a blocker\n4. Not this work',
      ),
    ),
  ).toBe(true);
  expect(adapter.capabilities).toMatchObject({ inlineActions: false, replyTo: false });
}, 20000);

test('NFR-AD-03 / FR-UI-03: a numbered recipient reply reaches the status action once', async () => {
  const destination = (
    await pool.query(`SELECT n.recipient_person_id AS "personId", n.thread_id AS "threadId"
    FROM notifications n JOIN labels l ON l.id = n.label_id JOIN unit_messages um ON um.unit_id = l.unit_id
    JOIN messages_raw m ON m.id = um.message_id WHERE m.provider_msg_id = 'pipeline-message' AND n.sent_at IS NOT NULL LIMIT 1`)
  ).rows[0];

  await pool.query(
    "UPDATE person_identities SET external_id = 'action-recipient' WHERE workspace_id = $1 AND person_id = $2 AND provider = 'fake'",
    [seed.workspaceId, destination.personId],
  );
  const receiver = express()
    .use(
      webhookRouter({
        ...services,
        lookupConnection: createConnectionLookup(pool),
        publish: publishCoalesce(queue, 0),
      }),
    )
    .use(errorHandler);
  const update = {
    eventId: 'recipient-reply',
    room: 'action-recipient',
    messageId: 'recipient-message',
    author: 'action-recipient',
    content: '1 ORD-0091',
    sentAt: instant.getTime(),
  };

  for (const payload of [update, update]) {
    expect(
      (
        await request(receiver)
          .post(`/api/v1/webhooks/fake/${source.connectionId}`)
          .set('X-Fake-Secret', 'fake-secret')
          .send(payload)
      ).status,
    ).toBe(200);
  }

  expect(
    (await pool.query('SELECT status FROM threads WHERE id = $1', [destination.threadId])).rows[0]
      .status,
  ).toBe('completed');
  expect(
    (
      await pool.query(
        'SELECT confirmed_by FROM progress_markers WHERE thread_id = $1 AND confirmed_by IS NOT NULL',
        [destination.threadId],
      )
    ).rows,
  ).toEqual([{ confirmed_by: destination.personId }]);
  expect(
    (await pool.query("SELECT id FROM messages_raw WHERE provider_msg_id = 'recipient-message'"))
      .rowCount,
  ).toBe(0);
});

test('FR-UI-03 / FR-CLM-05: numbered correction restores the operation once and sends through the provider', async () => {
  const receiver = express()
    .use(
      webhookRouter({
        ...services,
        lookupConnection: createConnectionLookup(pool),
        publish: publishCoalesce(queue, 0),
        publishNotification: publishNotification(queue),
      }),
    )
    .use(errorHandler);
  const update = {
    eventId: 'recipient-correction',
    room: 'action-recipient',
    messageId: 'correction-message',
    author: 'action-recipient',
    content: '4 ORD-0091',
    sentAt: instant.getTime(),
  };

  for (const payload of [{ ...update, author: 'unbound-person' }, update, update]) {
    expect(
      (
        await request(receiver)
          .post(`/api/v1/webhooks/fake/${source.connectionId}`)
          .set('X-Fake-Secret', 'fake-secret')
          .send(payload)
      ).status,
    ).toBe(200);
  }

  expect(
    (
      await pool.query(`SELECT c.id FROM corrections c JOIN labels l ON l.op_id = c.op_id
    JOIN unit_messages um ON um.unit_id = l.unit_id JOIN messages_raw m ON m.id = um.message_id
    WHERE m.provider_msg_id = 'pipeline-message'`)
    ).rowCount,
  ).toBe(1);
  await vi.waitFor(
    async () => {
      expect(
        (
          await pool.query(`SELECT n.id FROM notifications n JOIN labels l ON l.id = n.label_id
      JOIN unit_messages um ON um.unit_id = l.unit_id JOIN messages_raw m ON m.id = um.message_id
      WHERE m.provider_msg_id = 'pipeline-message' AND n.kind = 'correction' AND n.sent_at IS NOT NULL`)
        ).rowCount,
      ).toBe(1);
    },
    { timeout: 15000 },
  );
  expect(
    (
      await pool.query(
        "SELECT status FROM threads WHERE display_id = 'ORD-0091' AND workspace_id = $1",
        [seed.workspaceId],
      )
    ).rows[0].status,
  ).toBe('active');
}, 20000);

test('SRS §7.3: live CREATE uses a validated genesis kernel rather than attaching to a low-scoring work item', async () => {
  const receiver = express()
    .use(
      webhookRouter({
        ...services,
        lookupConnection: createConnectionLookup(pool),
        publish: publishCoalesce(queue, 0),
      }),
    )
    .use(errorHandler);
  const response = await request(receiver)
    .post(`/api/v1/webhooks/fake/${source.connectionId}`)
    .set('X-Fake-Secret', 'fake-secret')
    .send({
      eventId: 'genesis-update',
      room: 'fake-room',
      messageId: 'genesis-message',
      author: 'fake-person',
      content: 'Lakeview requests twelve cobalt binders; completion means collected.',
      sentAt: instant.getTime(),
    });

  expect(response.status).toBe(200);
  await vi.waitFor(
    async () => {
      expect(
        (
          await pool.query(
            "SELECT id FROM threads WHERE workspace_id = $1 AND summary = 'Lakeview cobalt binders order'",
            [seed.workspaceId],
          )
        ).rowCount,
      ).toBe(1);
    },
    { timeout: 15000 },
  );
  expect(
    (
      await pool.query(
        "SELECT link.thread_id FROM message_thread_link link JOIN messages_raw m ON m.id = link.message_id WHERE m.provider_msg_id = $1 AND link.role = 'genesis'",
        ['genesis-message'],
      )
    ).rowCount,
  ).toBe(1);
}, 20000);
