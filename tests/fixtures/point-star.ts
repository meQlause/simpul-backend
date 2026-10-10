import type { Pool, PoolClient } from 'pg';

export function pointStarSeed(clock: { now: () => Date }) {
  return { now: clock.now(), workspaceId: '00000000-0000-4000-8000-000000100001' };
}

type Seed = ReturnType<typeof pointStarSeed>;

async function seedPeople(client: PoolClient, seed: Seed) {
  await client.query(
    `INSERT INTO workspaces (id, name, descriptor, timezone, created_at)
    VALUES ($1, 'Point Star', 'Operations workspace', 'Asia/Jakarta', $2)`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `INSERT INTO people (id, workspace_id, name, level, email, created_at)
    SELECT md5('point-star-person-' || num)::uuid, $1, name, level, email, $2
    FROM (VALUES (1, 'Siti Aminah', 'staff', NULL), (2, 'Budi Santoso', 'staff', NULL),
      (3, 'Rina Anggraini', 'staff', NULL), (4, 'Andi Pratama', 'staff', NULL),
      (5, 'Mr. Hendra', 'executive', 'hendra@example.test')) AS sample(num, name, level, email)`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `UPDATE people SET manager_id = md5('point-star-person-' ||
    CASE WHEN name = 'Siti Aminah' THEN '5' ELSE '1' END)::uuid
    WHERE workspace_id = $1 AND level = 'staff'`,
    [seed.workspaceId],
  );
  await client.query(
    `UPDATE workspaces SET admin_person_id = md5('point-star-person-1')::uuid WHERE id = $1`,
    [seed.workspaceId],
  );
  await client.query(
    `INSERT INTO roles (id, workspace_id, role_key, name, team, created_at)
    SELECT md5('point-star-role-' || num)::uuid, $1, role_key, name, team, $2
    FROM (VALUES (1, 'operations', 'Operations Manager', 'Operations'),
      (2, 'warehouse', 'Warehouse Lead', 'Warehouse'), (3, 'sales', 'Sales Admin', 'Sales'),
      (4, 'finance', 'Finance', 'Finance')) AS sample(num, role_key, name, team)`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `INSERT INTO role_members (workspace_id, role_id, person_id, kind, created_at)
    SELECT $1, md5('point-star-role-' || num)::uuid,
      md5('point-star-person-' || CASE WHEN kind = 'member' THEN num
        WHEN num = 1 THEN 5 ELSE 1 END)::uuid, kind, $2
    FROM generate_series(1, 4) AS num CROSS JOIN (VALUES ('member'), ('backup')) AS sample(kind)`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `INSERT INTO person_identities (workspace_id, person_id, provider, handle, created_at)
    SELECT $1, md5('point-star-person-' || num)::uuid, 'telegram', handle, $2
    FROM (VALUES (1, '@siti_ops'), (2, '@budi_gudang'), (3, '@rina_sales'),
      (4, '@andi_finance')) AS sample(num, handle)`,
    [seed.workspaceId, seed.now],
  );
}

async function seedConfiguration(client: PoolClient, seed: Seed) {
  await client.query(
    `INSERT INTO policies (workspace_id, digest_time, created_at) VALUES ($1, '08:30', $2)`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `INSERT INTO vocab_domains (id, workspace_id, name, id_prefix, created_at)
    SELECT md5('point-star-domain-' || name)::uuid, $1, name, prefix, $2
    FROM (VALUES ('Order', 'ORD'), ('Finance', 'PAY'), ('Stock', 'STK'),
      ('Returns', NULL), ('Quality', NULL), ('Product samples', NULL)) AS sample(name, prefix)`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `INSERT INTO thresholds (workspace_id, scope, scope_id, key, value, created_at)
    VALUES ($1, 'domain', md5('point-star-domain-Order')::uuid, 'stalled_after_hours', 12, $2),
      ($1, 'workspace', NULL, 'questions_per_thread_per_day', 1, $2),
      ($1, 'workspace', NULL, 'questions_per_channel_per_day', 3, $2)`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `INSERT INTO aliases (workspace_id, alias, person_id, created_at)
    VALUES ($1, 'Pak Bud', md5('point-star-person-2')::uuid, $2)`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `INSERT INTO templates (id, workspace_id, key, audience, body, editable, created_at)
    VALUES (md5('point-star-template-internal')::uuid, $1, 'update', 'internal',
      '{{work_id}} · {{customer}} · {{summary}}', true, $2),
      (md5('point-star-template-external')::uuid, $1, 'update', 'external',
      '{{work_id}} · {{customer}} · Your order update is ready.', false, $2)`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `INSERT INTO rules (id, workspace_id, name, domain_id, condition_text,
      event_type, recipient_role_id, template_id, active, created_at)
    SELECT md5('point-star-rule-' || num)::uuid, $1, name, md5('point-star-domain-' || domain)::uuid,
      condition, event, md5('point-star-role-' || recipient)::uuid,
      md5('point-star-template-internal')::uuid, num <= 3, $2
    FROM (VALUES
      (1, 'New orders reach the warehouse', 'Order', 'A new order has been confirmed', 'new', 2),
      (2, 'Ready to ship, notify sales', 'Order', 'An order is ready to ship', 'progress', 3),
      (3, 'Payment updates reach finance', 'Finance', 'A customer payment is confirmed', 'resolution', 4),
      (4, 'Low stock, prepare the next step', 'Stock', 'Stock falls below minimum level', 'blocker', 1),
      (5, 'Return requests reach sales', 'Returns', 'A customer requests a return', 'new', 3),
      (6, 'Quality issues reach operations', 'Quality', 'Damaged goods or packaging reported', 'blocker', 1),
      (7, 'Stock replenished, notify warehouse', 'Stock', 'New stock arrival confirmed', 'resolution', 2),
      (8, 'Order cancelled, notify sales', 'Order', 'A customer explicitly cancels an order', 'resolution', 3)
    ) AS sample(num, name, domain, condition, event, recipient)`,
    [seed.workspaceId, seed.now],
  );
}

async function seedChannels(client: PoolClient, seed: Seed) {
  await client.query(
    `INSERT INTO bot_connections (id, workspace_id, provider, connection_name,
    provider_account_id, bot_username, bot_name, token_secret_ref, webhook_secret_ref, status,
    verified_at, webhook_checked_at, created_by, created_at, updated_at)
    VALUES (md5('point-star-bot')::uuid, $1, 'telegram', 'Simpul workspace bot', '240000000',
      '@simpul_workspace_bot', 'Simpul workspace bot', 'point-star-token', 'point-star-webhook',
      'ready', $2, $2, md5('point-star-person-1')::uuid, $2, $2)`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `INSERT INTO channels (id, workspace_id, provider, bot_connection_id,
    provider_chat_id, provider_chat_type, provider_chat_title, member_count, display_name, class,
    connection_status, monitored, privacy_mode_ok, visible_indicator_message_id, verified_at,
    monitoring_started_at, verified_config_version, authorization_ack_at, authorization_ack_by, created_at)
    SELECT md5('point-star-channel-' || num)::uuid, $1, 'telegram', md5('point-star-bot')::uuid,
      '-10024000000' || num, 'supergroup', name, members, name, class, 'active', true, true,
      'point-star-indicator-' || num, $2::timestamptz - interval '3 hours',
      $2::timestamptz - interval '3 hours', 1, $2::timestamptz - interval '3 hours',
      md5('point-star-person-1')::uuid, $2
    FROM (VALUES (1, 'Operations', 12, 'internal'), (2, 'Sales & Order', 8, 'external'),
      (3, 'Warehouse & Shipping', 6, 'internal')) AS sample(num, name, members, class)`,
    [seed.workspaceId, seed.now],
  );
}

async function seedWork(client: PoolClient, seed: Seed) {
  await client.query(
    `INSERT INTO threads (id, workspace_id, display_id, status, domain_id, channel_id,
    customer_label, summary, owner_person_id, genesis_confidence, last_activity_at, expires_at,
    closed_at, closure_kind, closure_reason, created_at)
    SELECT md5('point-star-thread-' || display)::uuid, $1, display, status,
      md5('point-star-domain-' || domain)::uuid, md5('point-star-channel-' || channel)::uuid,
      customer, summary, md5('point-star-person-' || owner)::uuid, 0.95,
      $2::timestamptz - age, CASE WHEN status = 'tentative' THEN $2::timestamptz + interval '24 hours' END,
      CASE WHEN status IN ('completed', 'cancelled', 'archived') THEN $2::timestamptz - age END,
      CASE WHEN status = 'cancelled' THEN 'cancelled'
        WHEN status IN ('completed', 'archived') THEN 'completed' END,
      CASE WHEN status = 'cancelled' THEN 'Cancelled by the customer' END, $2::timestamptz - interval '20 days'
    FROM (VALUES
      ('ORD-0091', 'active', 'Order', 3, 'Mrs. Sri', 'Aqua 600 ml · 3 cases', 2, interval '19 hours'),
      ('ORD-0098', 'active', 'Order', 2, 'Toko Berkah', 'Indomie noodles · 12 cases', 2, interval '12 minutes'),
      ('PAY-0034', 'active', 'Finance', 1, 'CV Maju Jaya', 'Payment confirmation · IDR 4.8m', 4, interval '38 minutes'),
      ('ORD-0095', 'completed', 'Order', 2, 'Mr. Hasan', 'Teh Pucuk · 8 cases', 3, interval '1 hour'),
      ('STK-0018', 'active', 'Stock', 3, 'Warehouse stock', 'Cooking oil 1 L · low stock', 2, interval '2 hours'),
      ('ORD-0087', 'completed', 'Order', 2, 'Toko Sumber Rezeki', 'Premium rice · 10 bags', 3, interval '3 hours'),
      ('ORD-0100', 'tentative', 'Order', 2, 'Toko Melati', 'Indomie noodles · 12 cases', 2, interval '8 minutes'),
      ('ORD-0083', 'cancelled', 'Order', 3, 'Toko Amanah', 'Aqua 600 ml · 3 cases', 2, interval '1 day'),
      ('ORD-0070', 'archived', 'Order', 2, 'Toko Sentosa', 'Teh Pucuk · 8 cases', 3, interval '14 days')
    ) AS sample(display, status, domain, channel, customer, summary, owner, age)`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `INSERT INTO threads (workspace_id, display_id, status, domain_id, channel_id,
    summary, genesis_confidence, last_activity_at, created_at)
    SELECT $1, 'ORD-' || lpad((100 + num)::text, 4, '0'), 'active', md5('point-star-domain-Order')::uuid,
      md5('point-star-channel-2')::uuid, 'Sample order update ' || num, 0.95,
      $2::timestamptz - interval '1 hour', $2 FROM generate_series(1, 44) AS num`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `INSERT INTO display_id_counters (workspace_id, domain_id, last_value, created_at)
    SELECT $1, id, CASE id_prefix WHEN 'ORD' THEN 144 WHEN 'PAY' THEN 34 ELSE 18 END, $2
    FROM vocab_domains WHERE workspace_id = $1 AND id_prefix IS NOT NULL`,
    [seed.workspaceId, seed.now],
  );
}

async function seedWorkHistory(client: PoolClient, seed: Seed) {
  await client.query(
    `INSERT INTO threads (workspace_id, display_id, status, domain_id, channel_id,
    summary, genesis_confidence, last_activity_at, closed_at, closure_kind, created_at)
    SELECT $1, 'ORD-' || lpad((144 + num)::text, 4, '0'), 'completed', md5('point-star-domain-Order')::uuid,
      md5('point-star-channel-2')::uuid, 'Sample completed order ' || num, 0.95,
      $2::timestamptz - CASE WHEN num <= 10 THEN interval '2 hours' ELSE interval '2 days' END,
      $2::timestamptz - CASE WHEN num <= 10 THEN interval '2 hours' ELSE interval '2 days' END,
      'completed', $2::timestamptz - interval '3 days' FROM generate_series(1, 72) AS num`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `UPDATE display_id_counters SET last_value = 216
    WHERE workspace_id = $1 AND domain_id = md5('point-star-domain-Order')::uuid`,
    [seed.workspaceId],
  );
  await client.query(
    `INSERT INTO progress_markers (workspace_id, thread_id, ts, text, type, created_at)
    VALUES ($1, md5('point-star-thread-ORD-0091')::uuid, $2::timestamptz - interval '19 hours',
      'Goods have been ready since yesterday at 16:02. Shipping has not been confirmed.', 'progress', $2)`,
    [seed.workspaceId, seed.now],
  );
}

async function seedReview(client: PoolClient, seed: Seed) {
  await client.query(
    `INSERT INTO review_items (workspace_id, kind, title, detail, channel_id,
    detected_text, detected_at, created_at)
    SELECT $1, kind, title, detail, md5('point-star-channel-' || channel)::uuid,
      detected, $2::timestamptz - age, $2::timestamptz - age
    FROM (VALUES
      ('unrouted', 'Returns need a routing rule', 'Toko Makmur requested a return for 2 damaged cases.', 2, 'Returns', interval '18 minutes'),
      ('unrouted', 'Delivery schedule changed', 'A redelivery request for order ORD-0093.', 3, 'Order', interval '42 minutes'),
      ('unrouted', 'Customer pricing adjustment', 'Special customer pricing needs an owner.', 2, 'Finance', interval '1 hour'),
      ('alias', 'Who does “Pak Bud” refer to?', 'This name appears in 3 warehouse updates.', 1, 'Pak Bud', interval '24 minutes'),
      ('alias', '“Bu Rin” is not recognized', 'Two messages mention a name not yet linked to a team member.', 2, 'Bu Rin', interval '52 minutes'),
      ('category', 'Product sample request', 'This update does not match an existing category.', 2, 'Product samples', interval '35 minutes'),
      ('unrouted', 'Damaged packaging reported', 'This update needs a returns or quality classification.', 3, 'Quality', interval '1 hour')
    ) AS sample(kind, title, detail, channel, detected, age)`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `INSERT INTO decisions (workspace_id, kind, title, detail, occurred_at, created_at)
    SELECT $1, kind, title, detail, $2::timestamptz - age, $2::timestamptz - age
    FROM (VALUES
      ('routing', 'ORD-0098 routed to Budi Santoso', 'The “New order → Warehouse” rule matched. The owner is available.', interval '11 minutes'),
      ('routing', 'PAY-0034 routed to Andi Pratama', 'Finance category matched. The 60-second hold has ended.', interval '37 minutes'),
      ('work', 'ORD-0095 reminders stopped', 'Customer receipt confirmation closes the work item.', interval '1 hour'),
      ('queue', 'Return request queued', 'Returns category detected. No rule matched.', interval '78 minutes'),
      ('digest', 'Morning digest available for Siti Aminah', 'Four work updates combined into one digest.', interval '151 minutes')
    ) AS sample(kind, title, detail, age)`,
    [seed.workspaceId, seed.now],
  );
}

async function seedAggregates(client: PoolClient, seed: Seed) {
  await client.query(
    `INSERT INTO messages_raw (id, workspace_id, channel_id, provider_msg_id,
    sender_external_id, body, body_safe, server_ts, received_ts, created_at)
    SELECT md5('point-star-message-' || num)::uuid, $1, md5('point-star-channel-2')::uuid,
      num::text, 'point-star-sender', 'Sample order update ' || num, 'Sample order update ' || num,
      $2::timestamptz - CASE WHEN num <= 1284 THEN interval '1 hour' ELSE interval '2 days' END,
      $2::timestamptz - CASE WHEN num <= 1284 THEN interval '1 hour' ELSE interval '2 days' END, $2
    FROM generate_series(1, 8426) AS num`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `INSERT INTO units (id, workspace_id, channel_id, text, triage_class, ts_first, ts_last, created_at)
    SELECT md5('point-star-unit-' || provider_msg_id)::uuid, $1, channel_id, body_safe, 'EVENT', server_ts, server_ts, server_ts
    FROM messages_raw WHERE workspace_id = $1`,
    [seed.workspaceId],
  );
  await client.query(
    `INSERT INTO unit_messages (workspace_id, unit_id, message_id, created_at)
    SELECT $1, md5('point-star-unit-' || provider_msg_id)::uuid, id, server_ts
    FROM messages_raw WHERE workspace_id = $1`,
    [seed.workspaceId],
  );
  await client.query(
    `INSERT INTO labels (id, workspace_id, unit_id, thread_id, domain_id, type,
    tense, evidence_message_ids, confidence, vocab_version, routed_at, created_at)
    SELECT md5('point-star-label-' || num)::uuid, $1, md5('point-star-unit-' || num)::uuid,
      md5('point-star-thread-ORD-0091')::uuid, md5('point-star-domain-Order')::uuid, 'progress',
      'sudah_terjadi', ARRAY[md5('point-star-message-' || num)::uuid], 0.95, 1, $2, $2
    FROM generate_series(1, 984) AS num`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `INSERT INTO notifications (workspace_id, label_id, thread_id, recipient_person_id,
    channel, body_rendered, held_until, sent_at, created_at)
    SELECT $1, md5('point-star-label-' || num)::uuid, md5('point-star-thread-ORD-0091')::uuid,
      md5('point-star-person-2')::uuid, 'telegram', 'Sample order update ' || num,
      $2::timestamptz - CASE WHEN num <= 156 THEN interval '1 hour' ELSE interval '2 days' END,
      $2::timestamptz - CASE WHEN num <= 156 THEN interval '1 hour' ELSE interval '2 days' END, $2
    FROM generate_series(1, 984) AS num`,
    [seed.workspaceId, seed.now],
  );
}

async function seedRuleMatches(client: PoolClient, seed: Seed) {
  await client.query(
    `INSERT INTO label_rule_matches (workspace_id, label_id, rule_id, matched_at, created_at)
    SELECT $1, md5('point-star-label-' || num)::uuid, md5('point-star-rule-' || rule)::uuid,
      $2::timestamptz - interval '2 days', $2
    FROM (VALUES (1, 64), (2, 48), (3, 22), (4, 8), (5, 6), (6, 4), (7, 10), (8, 3)) AS sample(rule, matches)
    CROSS JOIN LATERAL generate_series(1, matches) AS num`,
    [seed.workspaceId, seed.now],
  );
}

async function seedDelivery(client: PoolClient, seed: Seed) {
  await client.query(
    `INSERT INTO digests (id, workspace_id, recipient_person_id, scheduled_for, created_at)
    VALUES (md5('point-star-digest')::uuid, $1, md5('point-star-person-5')::uuid,
      $2::timestamptz - interval '151 minutes', $2)`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `INSERT INTO notifications (workspace_id, label_id, thread_id, recipient_person_id,
    channel, body_rendered, held_until, digest_id, kind, created_at)
    SELECT $1, md5('point-star-label-' || num)::uuid, md5('point-star-thread-ORD-0091')::uuid,
      md5('point-star-person-5')::uuid, 'email', 'Sample order update ' || num, $2,
      md5('point-star-digest')::uuid, 'update', $2 FROM generate_series(1, 4) AS num`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `INSERT INTO notifications (workspace_id, label_id, thread_id, recipient_person_id,
    channel, body_rendered, held_until, kind, created_at)
    VALUES ($1, md5('point-star-label-1')::uuid, md5('point-star-thread-ORD-0091')::uuid,
      md5('point-star-person-2')::uuid, 'telegram', 'ORD-0091 · Mrs. Sri · Shipping has not been confirmed.',
      $2::timestamptz + interval '29 minutes', 'reminder', $2)`,
    [seed.workspaceId, seed.now],
  );
  await client.query(
    `INSERT INTO open_questions (workspace_id, channel_id, thread_ids, asked_at, expires_at, created_at)
    VALUES ($1, md5('point-star-channel-2')::uuid,
      ARRAY[md5('point-star-thread-ORD-0098')::uuid, md5('point-star-thread-ORD-0095')::uuid,
        md5('point-star-thread-ORD-0087')::uuid], $2, $2::timestamptz + interval '1 day', $2)`,
    [seed.workspaceId, seed.now],
  );
}

export async function loadPointStarSeed(pool: Pool, seed: Seed) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const populate of [
      seedPeople,
      seedConfiguration,
      seedChannels,
      seedWork,
      seedWorkHistory,
      seedReview,
      seedAggregates,
      seedRuleMatches,
      seedDelivery,
    ]) {
      await populate(client, seed);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
