import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { parseCategory, parseAlias, parseTemplate } from './vocabulary.schema.js';
import {
  createCategory,
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
