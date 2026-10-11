import type { PoolClient } from 'pg';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { reconciledIdempotent } from '../../platform/db/idempotency.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import type { ActivationProvider } from '../../platform/providers/index.js';
import type { createSecretStore } from '../../platform/secrets/index.js';
import { recordConfigChange } from '../audit/index.js';
import { activationFailure, checksPass } from './activation.rules.js';
import { selectActivation, storeActivation } from './activation.repository.js';
import { selectChannels } from './channels.repository.js';
import { parseActivationOutcome, type parseActivation } from './activation.schema.js';

export type ActivationServices = {
  provider: ActivationProvider;
  secretStore: ReturnType<typeof createSecretStore>;
  publicBaseUrl: string;
  now: () => Date;
};

async function postIndicator(
  provider: ActivationProvider,
  connection: Parameters<ActivationProvider['send']>[0],
  chatId: string,
) {
  try {
    const result = await provider.send(connection, {
      kind: 'indicator',
      chatId,
      text: 'Simpul monitoring is active',
    });

    if ('retryAfter' in result) {
      throw new DomainError('E-TG-RATE-LIMITED', undefined, result.retryAfter);
    }

    return result;
  } catch (error) {
    if (
      error instanceof DomainError &&
      ['E-TG-SETUP-TIMEOUT', 'E-TG-RATE-LIMITED'].includes(error.code)
    ) {
      throw error;
    }

    throw new DomainError('E-TG-ACTIVATION-FAILED');
  }
}

async function completeActivation(
  tx: PoolClient,
  request: {
    scope: { workspaceId: string; actorId: string };
    input: ReturnType<typeof parseActivation>;
    now: Date;
  },
  outcome: unknown,
) {
  const activation = parseActivationOutcome(outcome);
  const row = await selectActivation(tx, request.scope.workspaceId, request.input);

  if (!row) {
    throw new DomainError('E-NOT-FOUND');
  }

  assertVerification(row, request.input, request.now);
  const scope = { ...request.scope, actorId: activation.actorId };

  await storeActivation(tx, scope, activation);
  await recordConfigChange(tx, {
    ...scope,
    tableName: 'channels',
    recordId: request.input.channelId,
    before: { monitored: false },
    after: { connectionStatus: 'active', monitored: true },
  });

  return (await selectChannels(tx, scope.workspaceId)).find(
    (channel: { id: string }) => channel.id === request.input.channelId,
  );
}

export async function activateChannel(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; actorId: string },
  input: ReturnType<typeof parseActivation>,
  services: ActivationServices,
) {
  return reconciledIdempotent(
    resolveConnection,
    {
      workspaceId: scope.workspaceId,
      endpoint: `/channels/${input.channelId}/activate`,
      key: input.key,
      payload: {
        verificationId: input.verificationId,
        authorizationAck: input.authorizationAck,
        expectedConfigVersion: input.expectedConfigVersion,
      },
    },
    {
      prepare: async (tx) => ({
        ...(await prepareActivation(tx, scope.workspaceId, input, services)),
        actorId: scope.actorId,
      }),
      complete: (tx, outcome) =>
        completeActivation(tx, { scope, input, now: services.now() }, outcome),
    },
  );
}

function assertVerification(
  row: NonNullable<Awaited<ReturnType<typeof selectActivation>>>,
  input: ReturnType<typeof parseActivation>,
  now: Date,
) {
  const failure = activationFailure({
    ...row,
    expectedConfigVersion: input.expectedConfigVersion,
    checkedAt: row.checkedAt?.getTime() ?? null,
    expiresAt: row.expiresAt?.getTime() ?? null,
    now: now.getTime(),
    checks: row.checks ?? [],
  });

  if (failure) {
    throw new DomainError(failure);
  }
}

async function prepareActivation(
  tx: PoolClient,
  workspaceId: string,
  input: ReturnType<typeof parseActivation>,
  services: ActivationServices,
) {
  const row = await selectActivation(tx, workspaceId, input);

  if (!row) {
    throw new DomainError('E-NOT-FOUND');
  }

  assertVerification(row, input, services.now());
  const connection = {
    credential: await services.secretStore.get(tx, workspaceId, 'bot_token', row.tokenRef),
    providerAccountId: row.providerAccountId,
    webhookUrl: `${services.publicBaseUrl.replace(/\/$/u, '')}/api/v1/webhooks/telegram/${row.connectionId}`,
  };
  const checks = await services.provider.checkReadiness(connection, row.providerChatId);

  if (!checksPass(checks, ['bot_identity', 'group', 'membership', 'privacy_mode', 'webhook'])) {
    throw new DomainError('E-TG-READINESS-INCOMPLETE');
  }

  const chat = await services.provider.describeChat(connection, row.providerChatId);
  const indicator = await postIndicator(services.provider, connection, row.providerChatId);

  return { ...chat, ...indicator, channelId: input.channelId, now: services.now().toISOString() };
}
