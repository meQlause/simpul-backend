import type { PoolClient } from 'pg';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { idempotent } from '../../platform/http/idempotency.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import type { SetupProvider } from '../../platform/providers/index.js';
import type { ConnectionSetup } from './connections-create.service.js';
import type { parseReplacement } from './connections.schema.js';
import {
  selectCredential,
  updateCredential,
  degradeConnection,
} from './connections-credentials.repository.js';
import { selectConnections } from './connections.repository.js';
import { recordConfigChange } from '../audit/index.js';
import { markConnectionNeedsAction } from '../channels/index.js';

type Scope = { workspaceId: string; actorId: string };
type Services = ConnectionSetup & { provider: SetupProvider };
type Replacement = {
  connectionId: string;
  key: string;
  input: ReturnType<typeof parseReplacement>;
};
type Stored = NonNullable<Awaited<ReturnType<typeof selectCredential>>>;

async function oldTokenRevoked(
  tx: PoolClient,
  workspaceId: string,
  stored: Stored,
  services: Services,
) {
  const token = await services.secretStore.get(tx, workspaceId, 'bot_token', stored.tokenRef);

  try {
    await services.provider.verifyCredential(token);

    return false;
  } catch (error) {
    return error instanceof DomainError && error.code === 'E-TG-TOKEN-INVALID';
  }
}

async function recheckWebhook(
  tx: PoolClient,
  workspaceId: string,
  request: { stored: Stored; botToken: string },
  services: Services,
) {
  const secret = await services.secretStore.get(
    tx,
    workspaceId,
    'webhook_secret',
    request.stored.webhookRef,
  );
  const url = `${services.publicBaseUrl.replace(/\/$/u, '')}/api/v1/webhooks/telegram/${request.stored.id}`;

  try {
    await services.provider.registerWebhook({ credential: request.botToken }, url, secret);

    return null;
  } catch (error) {
    if (!(await oldTokenRevoked(tx, workspaceId, request.stored, services))) {
      throw error;
    }

    return error instanceof DomainError ? error : new DomainError('E-INTERNAL');
  }
}

async function storeReplacement(
  tx: PoolClient,
  scope: Scope,
  change: {
    stored: Stored;
    input: Replacement['input'];
    account: Awaited<ReturnType<SetupProvider['verifyCredential']>>;
  },
  services: Services,
) {
  const { stored, input, account } = change;
  const tokenRef = await services.secretStore.put(tx, scope.workspaceId, {
    purpose: 'bot_token',
    value: input.botToken,
  });

  await updateCredential(tx, scope.workspaceId, stored.id, {
    tokenRef,
    account,
    connectionName: input.connectionName,
    now: services.now(),
  });

  if (!account.privacyModeOk) {
    await markConnectionNeedsAction(tx, scope, stored.id);
  }

  const data = (await selectConnections(tx, scope.workspaceId)).find(
    (row: { id: string }) => row.id === stored.id,
  );

  await recordConfigChange(tx, {
    ...scope,
    tableName: 'bot_connections',
    recordId: stored.id,
    before: {
      connectionName: stored.connectionName,
      credentialVersion: stored.credentialVersion,
      status: stored.status,
    },
    after: {
      connectionName: data.connectionName,
      credentialVersion: data.credentialVersion,
      status: data.status,
    },
  });

  return { data };
}

async function replaceCredential(
  tx: PoolClient,
  scope: Scope,
  request: Replacement,
  services: Services,
) {
  const stored = await selectCredential(tx, scope.workspaceId, request.connectionId);

  if (!stored) {
    throw new DomainError('E-NOT-FOUND');
  }

  if (stored.credentialVersion !== request.input.expectedCredentialVersion) {
    throw new DomainError('E-TG-VERSION-CONFLICT');
  }

  const account = await services.provider.verifyCredential(request.input.botToken);

  if (account.providerAccountId !== stored.providerAccountId) {
    throw new DomainError('E-TG-CREDENTIAL-BOT-MISMATCH');
  }

  const failure = await recheckWebhook(
    tx,
    scope.workspaceId,
    { stored, botToken: request.input.botToken },
    services,
  );

  if (failure) {
    await degradeConnection(tx, scope.workspaceId, stored.id);
    await markConnectionNeedsAction(tx, scope, stored.id);
    await recordConfigChange(tx, {
      ...scope,
      tableName: 'bot_connections',
      recordId: stored.id,
      before: { status: stored.status },
      after: { status: 'degraded' },
    });

    return { error: failure.code };
  }

  return storeReplacement(tx, scope, { stored, input: request.input, account }, services);
}

export async function rotateCredential(
  resolveConnection: ConnectionResolver,
  scope: Scope,
  request: Replacement,
  services: Services,
) {
  const result = await scopedTransaction(resolveConnection, scope.workspaceId, (tx) =>
    idempotent(
      tx,
      {
        workspaceId: scope.workspaceId,
        endpoint: `/telegram/connections/${request.connectionId}/credentials`,
        key: request.key,
        payload: request.input,
      },
      () => replaceCredential(tx, scope, request, services),
    ),
  );

  if ('error' in result) {
    throw new DomainError(result.error);
  }

  return result.data;
}
