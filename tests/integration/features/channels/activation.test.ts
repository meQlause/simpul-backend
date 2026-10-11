import { beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import {
  app,
  cookie,
  pool,
  provider,
  draftWithVerification,
} from '../../../helpers/channel-activation.js';

beforeEach(() => {
  provider.send.mockResolvedValue({ providerMessageId: 'test-indicator' });
});

function activate(
  draft: { channelId: string; verificationId: string },
  key: string,
  expectedConfigVersion = 1,
) {
  return request(app)
    .post(`/api/v1/channels/${draft.channelId}/activate`)
    .set('Cookie', cookie)
    .set('Idempotency-Key', key)
    .send({ verificationId: draft.verificationId, authorizationAck: true, expectedConfigVersion });
}

async function expectActive(channelId: string) {
  const row = (
    await pool.query(
      'SELECT monitored, connection_status, visible_indicator_message_id, authorization_ack_at, monitoring_started_at FROM channels WHERE id = $1',
      [channelId],
    )
  ).rows[0];

  expect(row).toMatchObject({
    monitored: true,
    connection_status: 'active',
    visible_indicator_message_id: 'test-indicator',
  });
  expect(row.authorization_ack_at).toEqual(new Date('2026-10-10T04:01:00Z'));
  expect(row.monitoring_started_at).toEqual(new Date('2026-10-10T04:01:00Z'));
  expect(provider.send).toHaveBeenCalledTimes(1);
}

test('SRS T-25: activation with the same Idempotency-Key twice posts one indicator message and replays the response', async () => {
  const draft = await draftWithVerification('repeat');
  const first = await activate(draft, 'repeat');
  const retry = await activate(draft, 'repeat');

  expect(first.status).toBe(200);
  expect(retry.status).toBe(200);
  expect(retry.body.data).toEqual(first.body.data);
  await expectActive(draft.channelId);
});

test('SRS T-25: two concurrent activation requests post one indicator', async () => {
  const draft = await draftWithVerification('concurrent');
  const replies = await Promise.all([activate(draft, 'concurrent'), activate(draft, 'concurrent')]);

  expect(replies.map(({ status }) => status)).toEqual([200, 200]);
  expect(replies[0].body.data).toEqual(replies[1].body.data);
  await expectActive(draft.channelId);
});

test('SRS T-25: reusing an activation key with changed input conflicts without another indicator', async () => {
  const draft = await draftWithVerification('conflict');

  expect((await activate(draft, 'conflict')).status).toBe(200);
  const changed = await activate(draft, 'conflict', 2);

  expect(changed.status).toBe(409);
  expect(changed.body.error.code).toBe('E-TG-IDEMPOTENCY-CONFLICT');
  await expectActive(draft.channelId);
});

test('Channels §6: if the database commit fails after the post, a reconciliation record lets the retry reuse the same message', async () => {
  const draft = await draftWithVerification('commit-failure');

  await pool.query(`CREATE FUNCTION fail_activation_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Test activation commit failure'; END $$;
    CREATE CONSTRAINT TRIGGER fail_activation_commit AFTER UPDATE ON channels DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (NEW.monitored) EXECUTE FUNCTION fail_activation_commit()`);

  try {
    const failed = await activate(draft, 'commit-failure');

    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe('E-INTERNAL');
    expect(
      (await pool.query('SELECT monitored FROM channels WHERE id = $1', [draft.channelId])).rows[0]
        .monitored,
    ).toBe(false);
    const record = (
      await pool.query('SELECT outcome, response FROM idempotency_keys WHERE key = $1', [
        'commit-failure',
      ])
    ).rows[0];

    expect(record).toMatchObject({
      response: null,
      outcome: {
        providerMessageId: 'test-indicator',
        channelId: draft.channelId,
        now: '2026-10-10T04:01:00.000Z',
      },
    });
    expect(JSON.stringify(record)).not.toContain('test-only-activation-token');
  } finally {
    await pool.query(
      'DROP TRIGGER fail_activation_commit ON channels; DROP FUNCTION fail_activation_commit()',
    );
  }

  expect((await activate(draft, 'commit-failure')).status).toBe(200);
  await expectActive(draft.channelId);
});
