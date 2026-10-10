import { beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import {
  app,
  cookie,
  pool,
  provider,
  draftWithVerification,
} from '../helpers/channel-activation.js';

beforeEach(() => {
  provider.send.mockRejectedValue(new Error('Indicator failed'));
});

test.each([
  ['readiness-incomplete', 'E-TG-READINESS-INCOMPLETE', 422],
  ['verification-expired', 'E-TG-VERIFICATION-EXPIRED', 409],
  ['version-conflict', 'E-TG-VERSION-CONFLICT', 409],
  ['indicator-failed', 'E-TG-ACTIVATION-FAILED', 502],
])('REG-008: %s returns %s and stores no active state', async (scenario, code, status) => {
  const draft = await draftWithVerification(String(scenario));
  const response = await request(app)
    .post(`/api/v1/channels/${draft.channelId}/activate`)
    .set('Cookie', cookie)
    .set('Idempotency-Key', String(scenario))
    .send({
      verificationId: draft.verificationId,
      authorizationAck: true,
      expectedConfigVersion: scenario === 'version-conflict' ? 2 : 1,
    });
  expect(response.status).toBe(status);
  expect(response.body.error.code).toBe(code);
  const stored = await pool.query(
    'SELECT monitored, monitoring_started_at, visible_indicator_message_id FROM channels WHERE id = $1',
    [draft.channelId],
  );
  expect(stored.rows[0]).toEqual({
    monitored: false,
    monitoring_started_at: null,
    visible_indicator_message_id: null,
  });
  expect(provider.send).toHaveBeenCalledTimes(scenario === 'indicator-failed' ? 1 : 0);
});
