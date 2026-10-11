import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordConfigChange } from '../audit/index.js';
import { advanceVocabularyVersion, getVocabularyVersion } from '../workspace/index.js';
import { findActivePerson } from '../people/index.js';
import {
  configurationWrite,
  insertCategory,
  insertAlias,
  selectVocabulary,
} from './vocabulary.repository.js';
import type { parseAlias, parseCategory } from './vocabulary.schema.js';

const allowedFields = ['work_id', 'customer', 'summary'];

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
        internal: { ...vocabulary.templates['internal'], allowedFields },
        sample: {
          work_id: 'ORD-0091',
          customer: 'Mrs. Sri',
          summary: '3 cases of Aqua are ready to ship.',
        },
      },
    };
  });
}
