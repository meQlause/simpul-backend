import { expect, test, vi } from 'vitest';
import request from 'supertest';
import { createTelegramProvider } from '../../../../src/platform/providers/index.js';
import {
  app,
  cookie,
  pool,
  provider,
  draftWithVerification,
} from '../../../helpers/channel-activation.js';

const TIMEOUT = 'E-TG-SETUP-TIMEOUT';
const RATE_LIMITED = 'E-TG-RATE-LIMITED';
const credential = 'test-only-error-token';

function scriptedProvider(scenario: string) {
  const send = vi.fn<typeof fetch>(async () => {
    if (scenario === 'timeout') {
      throw new DOMException('Provider timeout', 'TimeoutError');
    }

    if (scenario === 'body-timeout') {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new DOMException('Provider timeout', 'TimeoutError'));
          },
        }),
      );
    }

    return new Response(
      JSON.stringify({
        ok: false,
        error_code: 429,
        description: credential,
        parameters: { retry_after: 12 },
      }),
      { status: 429 },
    );
  });

  return { adapter: createTelegramProvider('https://telegram.example', send), send };
}

function assertFailure(
  response: {
    status: number;
    body: { error: { code: string; retryAfter?: number } };
    headers: Record<string, string>;
    text: string;
  },
  code: string,
) {
  expect(response.status).toBe(code === TIMEOUT ? 504 : 429);
  expect(response.body.error.code).toBe(code);

  if (code === RATE_LIMITED) {
    expect(response.body.error.retryAfter).toBe(12);
    expect(response.headers['retry-after']).toBe('12');
  }

  expect(response.text).not.toContain(credential);
}

test.each([
  ['timeout', TIMEOUT],
  ['body-timeout', TIMEOUT],
  ['rate-limit', RATE_LIMITED],
])(
  'SRS T-27: credential verification %s maps to %s without automatic retry',
  async (scenario, code) => {
    const { adapter, send } = scriptedProvider(scenario);

    provider.verifyCredential.mockImplementationOnce(adapter.verifyCredential);
    const response = await request(app)
      .post('/api/v1/telegram/connections/verify')
      .set('Cookie', cookie)
      .send({ botToken: credential });

    assertFailure(response, code);
    expect(send).toHaveBeenCalledTimes(1);
  },
);

test.each([
  ['timeout', TIMEOUT],
  ['rate-limit', RATE_LIMITED],
])('SRS T-27: indicator %s returns %s and leaves the group unmonitored', async (scenario, code) => {
  const draft = await draftWithVerification(scenario);
  const { adapter, send } = scriptedProvider(scenario);

  provider.send.mockImplementationOnce(adapter.send);
  const response = await request(app)
    .post(`/api/v1/channels/${draft.channelId}/activate`)
    .set('Cookie', cookie)
    .set('Idempotency-Key', scenario)
    .send({
      verificationId: draft.verificationId,
      authorizationAck: true,
      expectedConfigVersion: 1,
    });

  assertFailure(response, code);
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    (
      await pool.query(
        'SELECT monitored, monitoring_started_at, visible_indicator_message_id FROM channels WHERE id = $1',
        [draft.channelId],
      )
    ).rows[0],
  ).toEqual({ monitored: false, monitoring_started_at: null, visible_indicator_message_id: null });
});
