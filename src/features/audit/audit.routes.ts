import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { listController, detailController, messagesController } from './audit.controller.js';

export function auditRouter(resolveConnection: ConnectionResolver) {
  const router = Router();

  router.get('/decisions', listController(resolveConnection));
  router.get('/decisions/:decisionId', detailController(resolveConnection));
  router.get(
    '/messages',
    messagesController(resolveConnection, () => new Date()),
  );

  return router;
}
