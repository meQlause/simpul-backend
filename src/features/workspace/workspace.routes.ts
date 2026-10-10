import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { meController } from './workspace.controller.js';

export function workspaceRouter(resolveConnection: ConnectionResolver) {
  const router = Router();
  router.get('/me', meController(resolveConnection));
  return router;
}
