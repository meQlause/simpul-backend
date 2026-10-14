import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';

// Units for the message-log tests, added to a workspace seeded with the point-star fixture.
// One unit per outcome, plus units for the reasons, the resolution row, the routing row, a long
// body and a second channel.
export type MessageLogUnits = Record<
  | 'created'
  | 'attached'
  | 'held'
  | 'rejected'
  | 'ignored'
  | 'pending'
  | 'rejectedG3'
  | 'queryG1'
  | 'expiredQuestion'
  | 'candidates'
  | 'routed'
  | 'longText'
  | 'otherChannel',
  string
>;

type Base = { channelId: string; senderId: string; body: string; bodySafe: string };
type Ctx = {
  client: PoolClient;
  workspaceId: string;
  sender: string;
  operations: string;
  base: Base;
  threads: { ord91: string; ord98: string; ord95: string };
  units: MessageLogUnits;
};

const FAR_FUTURE = '2099-01-01T00:00:00Z';

async function channelId(client: PoolClient, workspaceId: string, name: string) {
  return (
    await client.query<{ id: string }>(
      'SELECT id FROM channels WHERE workspace_id = $1 AND display_name = $2',
      [workspaceId, name],
    )
  ).rows[0].id;
}

async function threadId(client: PoolClient, workspaceId: string, displayId: string) {
  return (
    await client.query<{ id: string }>(
      'SELECT id FROM threads WHERE workspace_id = $1 AND display_id = $2',
      [workspaceId, displayId],
    )
  ).rows[0].id;
}

async function insertUnit(
  client: PoolClient,
  workspaceId: string,
  spec: Base & {
    text: string;
    triageClass?: 'EVENT' | 'QUERY' | 'NOISE';
    minutes: number;
  },
) {
  const when = new Date(Date.parse('2026-10-10T06:00:00Z') + spec.minutes * 60000);
  const message = await client.query<{ id: string }>(
    `INSERT INTO messages_raw (workspace_id, channel_id, provider_msg_id, sender_external_id, body, body_safe, server_ts, received_ts)
     VALUES ($1, $2, $3, '4444', $4, $5, $6, $6) RETURNING id`,
    [workspaceId, spec.channelId, `ml-${randomUUID()}`, spec.body, spec.bodySafe, when],
  );
  const unit = await client.query<{ id: string }>(
    `INSERT INTO units (workspace_id, channel_id, sender_id, text, triage_class, ts_first, ts_last)
     VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
    [workspaceId, spec.channelId, spec.senderId, spec.text, spec.triageClass ?? 'EVENT', when],
  );

  await client.query(
    'INSERT INTO unit_messages (workspace_id, unit_id, message_id) VALUES ($1, $2, $3)',
    [workspaceId, unit.rows[0].id, message.rows[0].id],
  );

  return { unitId: unit.rows[0].id, messageId: message.rows[0].id };
}

// Copies one live label of ORD-0091 onto the unit, so the unit is attached to that work.
async function attachLabel(
  client: PoolClient,
  workspaceId: string,
  unitId: string,
  messageId: string,
) {
  const label = await client.query<{ id: string; thread_id: string }>(
    `INSERT INTO labels (workspace_id, unit_id, thread_id, domain_id, type, tense, magnitude, currency,
       actor_from, actor_to, evidence_message_ids, confidence, vocab_version)
     SELECT workspace_id, $2, thread_id, domain_id, type, tense, magnitude, currency,
       actor_from, actor_to, ARRAY[$3::uuid], confidence, vocab_version
     FROM labels WHERE workspace_id = $1 AND retracted_at IS NULL AND thread_id = (
       SELECT id FROM threads WHERE workspace_id = $1 AND display_id = 'ORD-0091')
     LIMIT 1 RETURNING id, thread_id`,
    [workspaceId, unitId, messageId],
  );

  return label.rows[0];
}

async function insertOrphan(
  client: PoolClient,
  workspaceId: string,
  unitId: string,
  reason: string,
) {
  await client.query('INSERT INTO orphans (workspace_id, unit_id, reason) VALUES ($1, $2, $3)', [
    workspaceId,
    unitId,
    reason,
  ]);
}

async function insertQuestion(
  client: PoolClient,
  workspaceId: string,
  spec: {
    unitId: string;
    channelId: string;
    threadIds: string[];
    askedAt: string;
    expiresAt: string;
  },
) {
  await client.query(
    `INSERT INTO open_questions (workspace_id, unit_id, channel_id, thread_ids, asked_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [workspaceId, spec.unitId, spec.channelId, spec.threadIds, spec.askedAt, spec.expiresAt],
  );
}

async function setup(client: PoolClient, workspaceId: string): Promise<Ctx> {
  const sales = await channelId(client, workspaceId, 'Sales & Order');
  const sender = (
    await client.query<{ id: string }>("SELECT md5('point-star-person-2')::uuid AS id")
  ).rows[0].id;

  return {
    client,
    workspaceId,
    sender,
    operations: await channelId(client, workspaceId, 'Operations'),
    base: { channelId: sales, senderId: sender, body: 'pesanan baru', bodySafe: 'pesanan baru' },
    threads: {
      ord91: await threadId(client, workspaceId, 'ORD-0091'),
      ord98: await threadId(client, workspaceId, 'ORD-0098'),
      ord95: await threadId(client, workspaceId, 'ORD-0095'),
    },
    units: {} as MessageLogUnits,
  };
}

async function seedArrivals(ctx: Ctx) {
  const { client, workspaceId, base, threads, units } = ctx;
  const created = await insertUnit(client, workspaceId, { ...base, text: 'created', minutes: 1 });

  await client.query(
    `INSERT INTO message_thread_link (workspace_id, message_id, thread_id, role, confidence)
     VALUES ($1, $2, $3, 'genesis', 1)`,
    [workspaceId, created.messageId, threads.ord98],
  );
  units.created = created.unitId;

  const attached = await insertUnit(client, workspaceId, { ...base, text: 'attached', minutes: 2 });

  await attachLabel(client, workspaceId, attached.unitId, attached.messageId);
  units.attached = attached.unitId;

  const pending = await insertUnit(client, workspaceId, { ...base, text: 'pending', minutes: 6 });

  units.pending = pending.unitId;

  const ignored = await insertUnit(client, workspaceId, {
    ...base,
    text: 'ignored',
    triageClass: 'NOISE',
    minutes: 5,
  });

  units.ignored = ignored.unitId;
}

async function seedQuestions(ctx: Ctx) {
  const { client, workspaceId, base, threads, units } = ctx;
  const held = await insertUnit(client, workspaceId, { ...base, text: 'held', minutes: 3 });

  await insertQuestion(client, workspaceId, {
    unitId: held.unitId,
    channelId: base.channelId,
    threadIds: [threads.ord91, threads.ord98],
    askedAt: '2026-10-10T06:03:00Z',
    expiresAt: FAR_FUTURE,
  });
  units.held = held.unitId;

  const expired = await insertUnit(client, workspaceId, {
    ...base,
    text: 'expired question',
    minutes: 9,
  });

  await insertQuestion(client, workspaceId, {
    unitId: expired.unitId,
    channelId: base.channelId,
    threadIds: [threads.ord91],
    askedAt: '2026-10-10T06:08:00Z',
    expiresAt: '2026-10-10T06:09:00Z',
  });
  units.expiredQuestion = expired.unitId;
}

async function seedOrphans(ctx: Ctx) {
  const { client, workspaceId, base, units } = ctx;
  const rejected = await insertUnit(client, workspaceId, { ...base, text: 'rejected', minutes: 4 });

  await insertOrphan(client, workspaceId, rejected.unitId, 'G3');
  units.rejected = rejected.unitId;

  const rejectedG3 = await insertUnit(client, workspaceId, {
    ...base,
    text: 'rejected G3 again',
    minutes: 7,
  });

  await insertOrphan(client, workspaceId, rejectedG3.unitId, 'G3');
  units.rejectedG3 = rejectedG3.unitId;

  const queryG1 = await insertUnit(client, workspaceId, {
    ...base,
    text: 'query G1',
    triageClass: 'QUERY',
    minutes: 8,
  });

  await insertOrphan(client, workspaceId, queryG1.unitId, 'G1');
  units.queryG1 = queryG1.unitId;
}

async function seedRouting(ctx: Ctx) {
  const { client, workspaceId, base, sender, threads, units } = ctx;
  const candidates = await insertUnit(client, workspaceId, {
    ...base,
    text: 'candidates',
    minutes: 10,
  });

  await client.query(
    `INSERT INTO unit_resolutions (workspace_id, unit_id, verdict, decided_by, candidates, chosen_thread_id, context_message_count)
     VALUES ($1, $2, 'GREY', 'model_context', $3::jsonb, $4, 2)`,
    [
      workspaceId,
      candidates.unitId,
      JSON.stringify([
        { threadId: threads.ord91, score: 0.9123 },
        { threadId: threads.ord98, score: 0.5849 },
        { threadId: threads.ord95, score: 0.1 },
      ]),
      threads.ord91,
    ],
  );
  units.candidates = candidates.unitId;

  const routed = await insertUnit(client, workspaceId, { ...base, text: 'routed', minutes: 11 });
  const label = await attachLabel(client, workspaceId, routed.unitId, routed.messageId);
  const notification = await client.query<{ id: string }>(
    `INSERT INTO notifications (workspace_id, label_id, thread_id, recipient_person_id, channel, body_rendered, held_until, sent_at, kind, destination_channel_id, stale_since, created_at)
     VALUES ($1, $2, $3, NULL, 'telegram', 'Routed', $4, $4, 'update', $5, $4, $4) RETURNING id`,
    [workspaceId, label.id, label.thread_id, new Date('2026-10-10T06:11:00Z'), base.channelId],
  );

  await client.query(
    `INSERT INTO decisions (workspace_id, kind, title, detail, occurred_at, thread_id, notification_id, recipient_person_id)
     VALUES ($1, 'routing', 'Routed to Budi', 'Routine', $2, $3, $4, $5)`,
    [
      workspaceId,
      new Date('2026-10-10T06:11:00Z'),
      label.thread_id,
      notification.rows[0].id,
      sender,
    ],
  );
  units.routed = routed.unitId;
}

async function seedText(ctx: Ctx) {
  const { client, workspaceId, base, sender, operations, units } = ctx;
  const longText = await insertUnit(client, workspaceId, {
    ...base,
    text: 'long text',
    body: 'x'.repeat(600),
    bodySafe: 'y'.repeat(600),
    minutes: 12,
  });

  units.longText = longText.unitId;

  const other = await insertUnit(client, workspaceId, {
    channelId: operations,
    senderId: sender,
    text: 'other channel',
    body: 'ops',
    bodySafe: 'ops',
    minutes: 13,
  });

  units.otherChannel = other.unitId;
}

export async function seedMessageLog(pool: Pool, workspaceId: string): Promise<MessageLogUnits> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const ctx = await setup(client, workspaceId);

    await seedArrivals(ctx);
    await seedQuestions(ctx);
    await seedOrphans(ctx);
    await seedRouting(ctx);
    await seedText(ctx);
    await client.query('COMMIT');

    return ctx.units;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
