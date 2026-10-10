import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import request from 'supertest';
import { app, cookie, pool, draftWithVerification } from '../../../helpers/channel-activation.js';

function edit(channelId: string, body: object) {
  return request(app)
    .patch('/api/v1/channels/' + channelId)
    .set('Cookie', cookie)
    .send(body);
}

test('Channels API section 4: name and language keep monitoring, but changing audience pauses and voids readiness', async () => {
  const draft = await draftWithVerification('Edit active channel');
  const activated = await request(app)
    .post('/api/v1/channels/' + draft.channelId + '/activate')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'edit-active-channel')
    .send({
      verificationId: draft.verificationId,
      authorizationAck: true,
      expectedConfigVersion: 1,
    });
  expect(activated.status).toBe(200);
  const renamed = await edit(draft.channelId, {
    displayName: 'Renamed group',
    primaryLanguage: 'id',
    expectedConfigVersion: 1,
  });
  expect(renamed.status).toBe(200);
  expect(renamed.body.data).toMatchObject({
    displayName: 'Renamed group',
    primaryLanguage: 'id',
    monitored: true,
    connectionStatus: 'active',
    configVersion: 2,
  });
  const changed = await edit(draft.channelId, { class: 'internal', expectedConfigVersion: 2 });
  expect(changed.status).toBe(200);
  expect(changed.body.data).toMatchObject({
    class: 'internal',
    monitored: false,
    connectionStatus: 'paused',
    configVersion: 3,
  });
  const detail = await request(app)
    .get('/api/v1/channels/' + draft.channelId)
    .set('Cookie', cookie);
  expect(detail.body.data.verification.activationReady).toBe(false);
  expect(
    (
      await pool.query('SELECT verified_config_version FROM channels WHERE id = $1', [
        draft.channelId,
      ])
    ).rows[0].verified_config_version,
  ).toBeNull();
});

test('Channels API section 4: concurrent edits with the same version write once and return one version conflict', async () => {
  const draft = await draftWithVerification('Concurrent edit');
  const edits = await Promise.all(
    ['First', 'Second'].map((displayName) =>
      edit(draft.channelId, { displayName, expectedConfigVersion: 1 }),
    ),
  );
  expect(edits.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(edits.find((response) => response.status === 409)?.body.error.code).toBe(
    'E-TG-VERSION-CONFLICT',
  );
  expect(
    (await pool.query('SELECT config_version FROM channels WHERE id = $1', [draft.channelId]))
      .rows[0].config_version,
  ).toBe(2);
  expect(
    (
      await pool.query(
        "SELECT id FROM config_audit WHERE table_name = 'channels' AND record_id = $1",
        [draft.channelId],
      )
    ).rowCount,
  ).toBe(2);
});

test.each(['providerChatId', 'botConnectionId'])(
  'Channels API section 4: the fixed identity field %s is rejected without a change',
  async (key) => {
    const draft = await draftWithVerification('Fixed identity');
    const before = (await pool.query('SELECT * FROM channels WHERE id = $1', [draft.channelId]))
      .rows;
    const result = await edit(draft.channelId, {
      [key]: key === 'providerChatId' ? '-99999' : randomUUID(),
      expectedConfigVersion: 1,
    });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('E-CHANNEL-IDENTITY-FIXED');
    expect(
      (await pool.query('SELECT * FROM channels WHERE id = $1', [draft.channelId])).rows,
    ).toEqual(before);
  },
);

test.each([
  { displayName: '' },
  { displayName: 'x'.repeat(121) },
  { class: 'unknown' },
  { primaryLanguage: 'unknown' },
  { workspaceId: randomUUID() },
])('Channels API section 4: invalid edit %j saves nothing', async (input) => {
  const draft = await draftWithVerification('Invalid edit');
  const result = await edit(draft.channelId, { ...input, expectedConfigVersion: 1 });
  expect(result.status).toBe(422);
  expect(result.body.error.code).toBe('E-TG-INPUT-INVALID');
  expect(
    (await pool.query('SELECT config_version FROM channels WHERE id = $1', [draft.channelId]))
      .rows[0].config_version,
  ).toBe(1);
});

test('Channels API section 4: a missing channel returns E-NOT-FOUND', async () => {
  const result = await edit(randomUUID(), { displayName: 'Unknown', expectedConfigVersion: 1 });
  expect(result.status).toBe(404);
  expect(result.body.error.code).toBe('E-NOT-FOUND');
});
