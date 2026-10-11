import { allowedTemplateFields, templateFieldsAllowed } from './vocabulary.rules.js';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordConfigChange } from '../audit/index.js';
import { advanceVocabularyVersion, getVocabularyVersion } from '../workspace/index.js';
import { findActivePerson } from '../people/index.js';
import {
  configurationWrite,
  lockInternalTemplate,
  storeInternalTemplate,
  insertCategory,
  insertAlias,
  selectVocabulary,
} from './vocabulary.repository.js';
import type { parseAlias, parseCategory, parseTemplate } from './vocabulary.schema.js';

type Scope = { workspaceId: string; actorId: string };

export async function createCategory(
  resolveConnection: ConnectionResolver,
  scope: Scope,
  input: ReturnType<typeof parseCategory>,
) {
  return configurationWrite(() =>
    scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
      const category = await insertCategory(tx, scope.workspaceId, input);
      const version = await advanceVocabularyVersion(tx, scope.workspaceId);

      await recordConfigChange(tx, {
        ...scope,
        tableName: 'vocab_domains',
        recordId: category.id,
        before: null,
        after: category,
      });

      return { category, version };
    }),
  );
}

export async function createAlias(
  resolveConnection: ConnectionResolver,
  scope: Scope,
  input: ReturnType<typeof parseAlias>,
) {
  return configurationWrite(() =>
    scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
      const person = await findActivePerson(tx, scope.workspaceId, input.personId);

      if (!person) {
        throw new DomainError('E-VALIDATION', [{ field: 'personId', issue: 'invalid' }]);
      }

      const alias = await insertAlias(tx, scope.workspaceId, input.alias, person);

      await recordConfigChange(tx, {
        ...scope,
        tableName: 'aliases',
        recordId: alias.id,
        before: null,
        after: alias,
      });

      return alias;
    }),
  );
}

export async function getVocabulary(resolveConnection: ConnectionResolver, workspaceId: string) {
  return scopedTransaction(resolveConnection, workspaceId, async (tx) => {
    const vocabulary = await selectVocabulary(tx, workspaceId);

    return {
      ...vocabulary,
      version: await getVocabularyVersion(tx, workspaceId),
      templates: {
        ...vocabulary.templates,
        internal: { ...vocabulary.templates['internal'], allowedFields: allowedTemplateFields },
        sample: {
          work_id: 'ORD-0091',
          customer: 'Mrs. Sri',
          summary: '3 cases of Aqua are ready to ship.',
        },
      },
    };
  });
}

export async function saveInternalTemplate(
  resolveConnection: ConnectionResolver,
  scope: Scope,
  input: ReturnType<typeof parseTemplate>,
) {
  if (!templateFieldsAllowed(input.body)) {
    throw new DomainError('E-TEMPLATE-FIELD-NOT-ALLOWED', [{ field: 'body', issue: 'invalid' }]);
  }

  return scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
    const before = await lockInternalTemplate(tx, scope.workspaceId);
    const after = await storeInternalTemplate(tx, scope.workspaceId, input.body);

    await recordConfigChange(tx, {
      ...scope,
      tableName: 'templates',
      recordId: after.id,
      before: before ?? null,
      after,
    });

    return { body: after.body, allowedFields: allowedTemplateFields };
  });
}
