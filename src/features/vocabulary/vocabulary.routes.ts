import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import {
  parseCategory,
  parseAlias,
  parseTemplate,
  parseCategoryId,
  parseCategoryEdit,
} from './vocabulary.schema.js';
import {
  createCategory,
  updateCategory,
  createAlias,
  getVocabulary,
  saveInternalTemplate,
} from './vocabulary.service.js';

const CREATED = 201;

type Scope = { workspaceId: string; actorId: string };

export function vocabularyRouter(resolveConnection: ConnectionResolver) {
  return Router()
    .get('/vocabulary', async (_request, response) => {
      const { workspaceId } = response.locals.scope as Scope;

      response.json({ data: await getVocabulary(resolveConnection, workspaceId) });
    })
    .post('/categories', async (request, response) => {
      const scope = response.locals.scope as Scope;

      response.status(CREATED).json({
        data: await createCategory(resolveConnection, scope, parseCategory(request.body)),
      });
    })
    .patch('/categories/:categoryId', async (request, response) => {
      const scope = response.locals.scope as Scope;

      response.json({
        data: await updateCategory(
          resolveConnection,
          scope,
          parseCategoryId(request.params.categoryId),
          parseCategoryEdit(request.body),
        ),
      });
    })
    .put('/templates/internal', async (request, response) => {
      const scope = response.locals.scope as Scope;

      response.json({
        data: await saveInternalTemplate(resolveConnection, scope, parseTemplate(request.body)),
      });
    })
    .post('/aliases', async (request, response) => {
      const scope = response.locals.scope as Scope;

      response
        .status(CREATED)
        .json({ data: await createAlias(resolveConnection, scope, parseAlias(request.body)) });
    });
}
