import { expect, test } from 'vitest';
import request from 'supertest';
import { createSecretStore } from '../../../../src/platform/secrets/index.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { scopedTransaction } from '../../../../src/platform/db/scoped-transaction.js';
import { DomainError } from '../../../../src/platform/errors/domain-error.js';
import {
  app,
  cookie,
  pool,
  provider,
  draftWithVerification,
} from '../../../helpers/channel-activation.js';

async function storedBot() {
  return (await pool.query('SELECT * FROM bot_connections')).rows[0];
}

function rotate(bot: { id: string; credential_version: number }, key: string) {
  return request(app)
    .put(`/api/v1/telegram/connections/${bot.id}/credentials`)
    .set('Cookie', cookie)
    .set('Idempotency-Key', key)
    .send({
      botToken: 'test-only-rotated-token',
      expectedCredentialVersion: bot.credential_version,
      connectionName: 'Rotated bot',
    });
}

async function expectReplacement(
  before: Awaited<ReturnType<typeof storedBot>>,
  responseText: string,
) {
  const after = await storedBot();

  expect(after.provider_account_id).toBe(before.provider_account_id);
  expect(after.webhook_secret_ref).toBe(before.webhook_secret_ref);
  expect(after.token_secret_ref).not.toBe(before.token_secret_ref);
  const token = await scopedTransaction(createConnectionResolver(pool), after.workspace_id, (tx) =>
    createSecretStore(Buffer.alloc(32, 7).toString('base64')).get(
      tx,
      after.workspace_id,
      'bot_token',
      after.token_secret_ref,
    ),
  );

  expect(token).toBe('test-only-rotated-token');
  expect(responseText).not.toContain(token);

  return after;
}

async function expectVerificationExpired(draft: { channelId: string; verificationId: string }) {
  const invalidated = await request(app)
    .post(`/api/v1/channels/${draft.channelId}/activate`)
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'old-verification')
    .send({
      verificationId: draft.verificationId,
      authorizationAck: true,
      expectedConfigVersion: 1,
    });

  expect(invalidated.status).toBe(409);
  expect(invalidated.body.error.code).toBe('E-TG-VERIFICATION-EXPIRED');
}

test('SRS T-22: rotating to the same bot increments credentialVersion, replaces the encrypted credential and voids open verifications', async () => {
  const drafts = await Promise.all([
    draftWithVerification('rotation-first'),
    draftWithVerification('rotation-second'),
  ]);
  const before = await storedBot();
  const response = await rotate(before, 'same-bot');

  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    id: before.id,
    connectionName: 'Rotated bot',
    credentialVersion: before.credential_version + 1,
  });
  const after = await expectReplacement(before, response.text);

  await Promise.all(drafts.map(expectVerificationExpired));
  expect(provider.send).not.toHaveBeenCalled();
  const replay = await rotate(before, 'same-bot');

  expect(replay.status).toBe(200);
  expect(replay.body.data).toEqual(response.body.data);
  expect((await storedBot()).credential_version).toBe(after.credential_version);
  expect(provider.registerWebhook).toHaveBeenCalledTimes(1);
});

async function snapshot() {
  return (
    await pool.query(`SELECT 'bot' AS kind, to_jsonb(row) AS value FROM bot_connections AS row
    UNION ALL SELECT 'secret', to_jsonb(row) FROM secrets AS row
    UNION ALL SELECT 'verification', to_jsonb(row) FROM channel_verifications AS row
    UNION ALL SELECT 'channel', to_jsonb(row) FROM channels AS row
    UNION ALL SELECT 'audit', to_jsonb(row) FROM config_audit AS row
    UNION ALL SELECT 'idempotency', to_jsonb(row) FROM idempotency_keys AS row ORDER BY kind, value`)
  ).rows;
}

test('SRS T-22: a different bot returns 422 E-TG-CREDENTIAL-BOT-MISMATCH and changes nothing', async () => {
  const before = await snapshot();

  provider.verifyCredential.mockResolvedValueOnce({
    providerAccountId: 'different-bot',
    botUsername: 'other_bot',
    botName: 'Other bot',
    canJoinGroups: true,
    privacyModeOk: true,
  });
  const response = await rotate(await storedBot(), 'different-bot');

  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe('E-TG-CREDENTIAL-BOT-MISMATCH');
  expect(await snapshot()).toEqual(before);
  expect(provider.registerWebhook).not.toHaveBeenCalled();
});

test('Connections §4: a stale credential version changes nothing and does not call the provider', async () => {
  const before = await snapshot();
  const bot = await storedBot();
  const response = await rotate(
    { ...bot, credential_version: bot.credential_version + 1 },
    'stale-version',
  );

  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('E-TG-VERSION-CONFLICT');
  expect(await snapshot()).toEqual(before);
  expect(provider.verifyCredential).not.toHaveBeenCalled();
});

test('Connections §4: if the old token is revoked and the new webhook check fails, the connection is degraded and its groups need action', async () => {
  const bot = await storedBot();

  provider.verifyCredential
    .mockResolvedValueOnce({
      providerAccountId: bot.provider_account_id,
      botUsername: 'test_bot',
      botName: 'Test bot',
      canJoinGroups: true,
      privacyModeOk: true,
    })
    .mockRejectedValueOnce(new DomainError('E-TG-TOKEN-INVALID'));
  provider.registerWebhook.mockRejectedValueOnce(new DomainError('E-TG-WEBHOOK-CONFLICT'));
  const response = await rotate(bot, 'revoked-token');

  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('E-TG-WEBHOOK-CONFLICT');
  expect(await storedBot()).toMatchObject({
    status: 'degraded',
    credential_version: bot.credential_version,
    token_secret_ref: bot.token_secret_ref,
  });
  const groups = (await pool.query('SELECT monitored, connection_status FROM channels')).rows;

  expect(groups).toHaveLength(2);

  for (const group of groups) {
    expect(group).toEqual({ monitored: false, connection_status: 'needs_action' });
  }
});
