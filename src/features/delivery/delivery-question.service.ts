import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { createSecretStore } from '../../platform/secrets/index.js';
import type { createProviderRegistry } from '../../platform/providers/index.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { pendingQuestion } from './delivery-question.repository.js';
import { questionActions, renderActions } from './delivery.rules.js';

type Services = {
  resolveConnection: ConnectionResolver;
  now: () => Date;
  secretStore: ReturnType<typeof createSecretStore>;
  providers: ReturnType<typeof createProviderRegistry>;
  publicBaseUrl: string;
};

const questionText =
  'Which order did you mean?\nChoose one of the known candidates. A question never creates a new work item.';

// ponytail: there is no sent marker, so a retry after a successful send repeats the question;
// add open_questions.posted_at if that is ever seen in practice.
export async function sendQuestion(
  services: Services,
  scope: { workspaceId: string; questionId: string },
) {
  return scopedTransaction(services.resolveConnection, scope.workspaceId, async (tx) => {
    const pending = await pendingQuestion(tx, scope, services.now());

    if (!pending) {
      return;
    }

    const credential = await services.secretStore.get(
      tx,
      scope.workspaceId,
      'bot_token',
      pending.tokenRef,
    );
    const adapter = services.providers.adapterFor(pending.provider);
    const rendered = renderActions(
      questionActions(scope.questionId, pending.labels, adapter.capabilities.inlineActions),
      adapter.capabilities,
    );
    const result = await adapter.send(
      {
        credential,
        providerAccountId: pending.providerAccountId,
        webhookUrl: `${services.publicBaseUrl.replace(/\/$/u, '')}/api/v1/webhooks/${pending.provider}/${pending.connectionId}`,
      },
      {
        kind: 'question',
        chatId: pending.chatId,
        text: [questionText, rendered.text].filter(Boolean).join('\n'),
        actions: rendered.actions,
      },
    );

    if ('retryAfter' in result) {
      throw new DomainError('E-INTERNAL', undefined, result.retryAfter);
    }

    // A group the bot cannot reach fails the job as before; FR-TG-13 is about people only.
    if ('unreachable' in result) {
      throw new DomainError('E-INTERNAL');
    }
  });
}
