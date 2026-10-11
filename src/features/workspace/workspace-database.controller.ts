import type { RequestHandler } from 'express';
import { parseDatabaseConnection } from './workspace-database.schema.js';
import type { DatabaseServices } from '../../platform/db/database-setup.js';
import { saveDatabase } from './workspace-database.service.js';

export const databaseSetupValidation: RequestHandler = (request, response, next) => {
  if (request.method === 'PUT' && response.locals.scope.databaseSetupRequired) {
    parseDatabaseConnection(request.body, true);
  }

  next();
};

export function saveDatabaseController(services: DatabaseServices): RequestHandler {
  return async (request, response) => {
    const { workspaceId } = response.locals.scope;

    response.json({ data: await saveDatabase(services, workspaceId, request.body) });
  };
}
