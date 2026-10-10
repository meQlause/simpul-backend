import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { meController, settingsController } from './workspace.controller.js';

export function workspaceRouter(resolveConnection: ConnectionResolver) {
  const router = Router();
  router.get('/me', meController(resolveConnection));
  router.put('/settings', settingsController(resolveConnection));
  return router;
}
