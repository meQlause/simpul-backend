import type { PoolClient } from 'pg';
import {
  allowedTemplateFields,
  templateFieldsAllowed,
  formatDisplayId,
} from './vocabulary.rules.js';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordConfigChange } from '../audit/index.js';
import { advanceVocabularyVersion, getVocabularyVersion } from '../workspace/index.js';
import { findActivePerson } from '../people/index.js';
import {
  configurationWrite,
  incrementDisplayCounter,
  lockCategory,
  editCategory,
  lockInternalTemplate,
  storeInternalTemplate,
  insertCategory,
  insertAlias,
  reuseAlias,
  activeCategory,
  selectVocabulary,
} from './vocabulary.repository.js';
import type {
  parseAlias,
  parseCategory,
  parseCategoryEdit,
  parseTemplate,
} from './vocabulary.schema.js';

const validationCode = 'E-VALIDATION';

type Scope = { workspaceId: string; actorId: string };

export async function requireActiveCategory(tx: PoolClient, workspaceId: string, id: string) {
  if (!(await activeCategory(tx, workspaceId, id))) {
    throw new DomainError(validationCode, [{ field: 'categoryId', issue: 'invalid' }]);
  }
}

export async function ensureAlias(
  tx: PoolClient,
  scope: Scope,
  input: { alias: string; personId: string },
) {
  const person = await findActivePerson(tx, scope.workspaceId, input.personId);

  if (!person) {
    throw new DomainError(validationCode, [{ field: 'personId', issue: 'invalid' }]);
  }

  const alias = await reuseAlias(tx, scope.workspaceId, input.alias, input.personId);

  if (!alias) {
    throw new DomainError(validationCode, [{ field: 'alias', issue: 'duplicate' }]);
  }

  if (alias.inserted) {
    await recordConfigChange(tx, {
      ...scope,
      tableName: 'aliases',
      recordId: alias.id,
      before: null,
      after: { id: alias.id, alias: input.alias, person },
    });
  }

  return alias.id;
}

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
        throw new DomainError(validationCode, [{ field: 'personId', issue: 'invalid' }]);
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

export async function updateCategory(
  resolveConnection: ConnectionResolver,
  scope: Scope,
  id: string,
  input: ReturnType<typeof parseCategoryEdit>,
) {
  return configurationWrite(() =>
    scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
      const before = await lockCategory(tx, scope.workspaceId, id);

      if (!before) {
        throw new DomainError('E-NOT-FOUND');
      }

      if (input.idPrefix !== undefined && before.prefixInUse) {
        throw new DomainError('E-VOCAB-PREFIX-FIXED', [{ field: 'idPrefix', issue: 'invalid' }]);
      }

      await editCategory(tx, scope.workspaceId, id, input);
      const category = { ...before, ...input };
      const promptChanged =
        (input.description !== undefined && input.description !== before.description) ||
        (input.example !== undefined && input.example !== before.example);
      const version = promptChanged
        ? await advanceVocabularyVersion(tx, scope.workspaceId)
        : await getVocabularyVersion(tx, scope.workspaceId);

      await recordConfigChange(tx, {
        ...scope,
        tableName: 'vocab_domains',
        recordId: id,
        before,
        after: category,
      });

      return { category, version };
    }),
  );
}

export async function allocateDisplayId(tx: PoolClient, workspaceId: string, domainId: string) {
  const category = await lockCategory(tx, workspaceId, domainId);

  if (!category) {
    throw new DomainError('E-NOT-FOUND');
  }

  if (!category.idPrefix) {
    throw new DomainError(validationCode, [{ field: 'idPrefix', issue: 'required' }]);
  }

  return formatDisplayId(
    category.idPrefix,
    await incrementDisplayCounter(tx, workspaceId, domainId),
  );
}
