import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { listController, itemController, resolveController } from './review-queue.controller.js';
import type { ReviewServices } from './review-queue.service.js';

export function reviewRouter(
  resolveConnection: ConnectionResolver,
  services: ReviewServices = { now: () => new Date() },
) {
  const router = Router();

  router.get('/review-items', listController(resolveConnection));
  router.get('/review-items/:itemId', itemController(resolveConnection));
  router.post('/review-items/:itemId/resolve', resolveController(resolveConnection, services));

  return router;
}
