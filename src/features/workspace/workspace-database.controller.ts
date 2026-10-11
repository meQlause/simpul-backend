import type { RequestHandler } from 'express';
import { parseDatabaseConnection } from './workspace-database.schema.js';

export const databaseSetupValidation: RequestHandler = (request, response, next) => {
  if (request.method === 'PUT' && response.locals.scope.databaseSetupRequired) {
    parseDatabaseConnection(request.body, true);
  }

  next();
};
