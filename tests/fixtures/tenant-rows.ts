import type { Pool } from 'pg';

const instant = '2026-10-10T04:01:00.000Z';
const later = '2026-10-10T04:11:00.000Z';
const dimensionCount = 768;

function identityRows(workspaceId: string) {
  return [
    ['people', { name: 'Test operator', auth_user_id: workspaceId }],
    ['roles', { role_key: 'operator', name: 'Operator' }],
    ['role_members', { role_id: workspaceId, person_id: workspaceId, kind: 'member' }],
    [
      'person_identities',
      { person_id: workspaceId, provider: 'telegram', external_id: workspaceId },
    ],
    ['policies', { digest_time: '08:30' }],
    ['vocab_domains', { name: 'Order', id_prefix: 'ORD' }],
    [
      'thresholds',
      { scope: 'domain', scope_id: workspaceId, key: 'stalled_after_hours', value: '12' },
    ],
    ['aliases', { alias: 'Operator', person_id: workspaceId }],
    [
      'templates',
      { key: 'update', audience: 'internal', body: '{{work_id}} · {{customer}} · {{summary}}' },
    ],
    ['display_id_counters', { domain_id: workspaceId }],
    [
      'rules',
      {
        name: 'Route orders',
        domain_id: workspaceId,
        condition_text: 'An order is confirmed',
        event_type: 'new',
        recipient_role_id: workspaceId,
        template_id: workspaceId,
      },
    ],
  ] as const;
}

function channelRows(workspaceId: string) {
  return [
    [
      'bot_connections',
      {
        provider: 'telegram',
        connection_name: 'Test connection',
        provider_account_id: workspaceId,
        bot_username: 'test_bot',
        bot_name: 'Test bot',
        token_secret_ref: workspaceId,
        webhook_secret_ref: workspaceId,
        created_by: workspaceId,
      },
    ],
    [
      'channels',
      {
        provider: 'telegram',
        bot_connection_id: workspaceId,
        provider_chat_id: workspaceId,
        display_name: 'Test channel',
      },
    ],
    [
      'channel_connection_sessions',
      {
        bot_connection_id: workspaceId,
        created_by: workspaceId,
        code_hash: Buffer.from(workspaceId),
        purpose: 'identify_group',
        created_at: instant,
        expires_at: later,
      },
    ],
    [
      'channel_verifications',
      {
        channel_id: workspaceId,
        bot_connection_id: workspaceId,
        config_version: 1,
        credential_version: 1,
        checks: '[]',
        status: 'pass',
        checked_at: instant,
        expires_at: later,
      },
    ],
    ['provider_updates', { bot_connection_id: workspaceId, update_id: '1' }],
  ] as const;
}

function messageRows(workspaceId: string) {
  return [
    [
      'messages_raw',
      {
        channel_id: workspaceId,
        provider_msg_id: '1',
        sender_external_id: workspaceId,
        server_ts: instant,
        received_ts: instant,
      },
    ],
    [
      'units',
      {
        channel_id: workspaceId,
        sender_id: workspaceId,
        text: 'An order is confirmed',
        ts_first: instant,
        ts_last: instant,
      },
    ],
    ['unit_messages', { unit_id: workspaceId, message_id: workspaceId }],
    ['media_outcomes', { message_id: workspaceId, outcome: 'transcript' }],
    [
      'unit_embeddings',
      {
        unit_id: workspaceId,
        embedding: JSON.stringify(
          Array.from({ length: dimensionCount }, (_value, position) => Number(position === 0)),
        ),
        model: 'test-embedding',
      },
    ],
  ] as const;
}

function workRows(workspaceId: string) {
  return [
    ['nodes', { type: 'Customer' }],
    [
      'edges',
      {
        from_id: workspaceId,
        to_id: workspaceId,
        type: 'related_to',
        weight: '1',
        created_by: 'manual',
      },
    ],
    [
      'threads',
      {
        display_id: 'ORD-0001',
        status: 'active',
        domain_id: workspaceId,
        channel_id: workspaceId,
        summary: 'Test order',
        genesis_confidence: '1',
      },
    ],
    [
      'labels',
      {
        unit_id: workspaceId,
        thread_id: workspaceId,
        op_id: workspaceId,
        type: 'progress',
        tense: 'sudah_terjadi',
        evidence_message_ids: [workspaceId],
        confidence: '1',
        vocab_version: 1,
      },
    ],
    ['label_rule_matches', { label_id: workspaceId, rule_id: workspaceId }],
    [
      'progress_markers',
      { thread_id: workspaceId, ts: instant, text: 'Order confirmed', type: 'progress' },
    ],
    [
      'message_thread_link',
      { message_id: workspaceId, thread_id: workspaceId, role: 'genesis', confidence: '1' },
    ],
    [
      'notifications',
      {
        label_id: workspaceId,
        thread_id: workspaceId,
        recipient_person_id: workspaceId,
        channel: 'telegram',
        body_rendered: 'Order confirmed',
        held_until: later,
      },
    ],
    [
      'corrections',
      {
        op_id: workspaceId,
        notification_id: workspaceId,
        corrected_by: workspaceId,
        correction_type: 'not_this_work',
        previous_state: '{}',
      },
    ],
  ] as const;
}

function operationalRows(workspaceId: string) {
  return [
    ['digests', { recipient_person_id: workspaceId, scheduled_for: later }],
    ['digest_items', { digest_id: workspaceId, label_id: workspaceId, rule_id: workspaceId }],
    [
      'open_questions',
      { thread_ids: [workspaceId], channel_id: workspaceId, asked_at: instant, expires_at: later },
    ],
    ['orphans', { unit_id: workspaceId, reason: 'Test unresolved unit' }],
    ['unit_resolutions', { unit_id: workspaceId, verdict: 'CREATE', decided_by: 'score' }],
    [
      'unit_corrections',
      {
        unit_id: workspaceId,
        action: 'attach',
        thread_id: workspaceId,
        previous_outcome: 'rejected',
        corrected_by: workspaceId,
      },
    ],
    ['message_access_log', { person_id: workspaceId, channel_id: workspaceId }],
    [
      'review_items',
      {
        kind: 'unrouted',
        title: 'Test review',
        detail: 'Test routing gap',
        channel_id: workspaceId,
      },
    ],
    ['decisions', { kind: 'work', title: 'Test decision', detail: 'Order confirmed' }],
    ['config_audit', { actor_id: workspaceId, table_name: 'policies', record_id: workspaceId }],
    [
      'idempotency_keys',
      { key: 'test-key', endpoint: '/test', fingerprint: Buffer.from('test-fingerprint') },
    ],
    ['workspace_keys', { wrapped_key: Buffer.from('test-wrapped-key') }],
    [
      'secrets',
      {
        purpose: 'database_url',
        ciphertext: Buffer.from('test-ciphertext'),
        nonce: Buffer.alloc(12),
      },
    ],
    [
      'mail_connections',
      {
        host: 'smtp.example.test',
        port: 587,
        username: 'test',
        from_address: 'test@example.test',
        password_secret_ref: workspaceId,
      },
    ],
    [
      'workspace_databases',
      {
        workspace_name: 'Test workspace',
        timezone: 'Asia/Jakarta',
        admin_auth_user_id: workspaceId,
      },
    ],
    [
      'connection_routes',
      { bot_connection_id: workspaceId, provider: 'telegram', provider_account_id: workspaceId },
    ],
  ] as const;
}

async function insertRow(pool: Pool, table: string, values: Record<string, unknown>) {
  const columns = Object.keys(values);
  const placeholders = columns.map((_value, position) => `$${position + 1}`).join(', ');
  const columnList = columns.map((column) => `"${column}"`).join(', ');

  await pool.query(
    `INSERT INTO "${table}" (${columnList}) VALUES (${placeholders})`,
    Object.values(values),
  );
}

export async function seedTenantRows(pool: Pool, workspaceId: string) {
  await insertRow(pool, 'workspaces', {
    id: workspaceId,
    name: 'Test workspace',
    timezone: 'Asia/Jakarta',
  });
  const tables = await pool.query<{ table_name: string; column_name: string }>(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id'",
  );
  const withId = new Set(tables.rows.map(({ table_name }) => table_name));
  const rows = [
    ...identityRows(workspaceId),
    ...channelRows(workspaceId),
    ...messageRows(workspaceId),
    ...workRows(workspaceId),
    ...operationalRows(workspaceId),
  ];

  for (const [table, values] of rows) {
    const identity = withId.has(table) ? { id: workspaceId } : {};

    await insertRow(pool, table, { ...identity, workspace_id: workspaceId, ...values });
  }
}
