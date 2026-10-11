import type { RequestHandler } from 'express';
import { parseDatabaseConnection } from './workspace-database.schema.js';
import { checkDatabaseSetup, type DatabaseServices } from '../../platform/db/database-setup.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { selectWorkspaceDatabase } from '../../platform/db/workspace-databases.repository.js';
import { DomainError } from '../../platform/errors/domain-error.js';

export const databaseSetupValidation: RequestHandler = (request, response, next) => {
  if (request.method === 'PUT' && response.locals.scope.databaseSetupRequired) {
    parseDatabaseConnection(request.body, true);
  }

  next();
};

export function databasePreflightController(services: DatabaseServices): RequestHandler {
  return async (request, response, next) => {
    const { workspaceId } = response.locals.scope;
    const row = await scopedTransaction(
      async () => services.systemPool,
      workspaceId,
      (tx) => selectWorkspaceDatabase(tx, workspaceId),
    );

    if (!row) {
      throw new DomainError('E-NOT-FOUND');
    }

    const pending = row.status === 'pending';
    const input = parseDatabaseConnection(request.body, pending);

    await checkDatabaseSetup(
      { connectionString: input.connectionString, workspaceId, pending },
      services,
    );
    next();
  };
}
