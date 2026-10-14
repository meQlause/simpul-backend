import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { CorrectionServices } from '../understanding/index.js';
import {
  listController,
  detailController,
  messagesController,
  correctController,
} from './audit.controller.js';

type AuditServices = Partial<Pick<CorrectionServices, 'model' | 'publishMatcher'>>;

export function auditRouter(resolveConnection: ConnectionResolver, services: AuditServices = {}) {
  const router = Router();

  router.get('/decisions', listController(resolveConnection));
  router.get('/decisions/:decisionId', detailController(resolveConnection));
  router.get(
    '/messages',
    messagesController(resolveConnection, () => new Date()),
  );

  // Without a model the correction cannot draft a summary, so the route is left unmounted.
  if (services.model) {
    router.post(
      '/messages/:unitId/correct',
      correctController({
        resolveConnection,
        model: services.model,
        now: () => new Date(),
        publishMatcher: services.publishMatcher,
      }),
    );
  }

  return router;
}
