import express, { Router } from 'express';
import { z as schema } from 'zod';
import { DomainError } from '../../platform/errors/domain-error.js';
import { authenticateWebhook, receiveUpdate, type WebhookServices } from './ingest.service.js';

export function webhookRouter(services: WebhookServices) {
  const router = Router();
  router.post(
    '/api/v1/webhooks/telegram/:connectionId',
    async (request, response, next) => {
      const connectionId = schema.guid().safeParse(request.params.connectionId);
      if (!connectionId.success) {
        throw new DomainError('E-NOT-FOUND');
      }
      response.locals.webhookScope = await authenticateWebhook(services, connectionId.data, {
        headers: request.headers,
      });
      next();
    },
    express.json(),
    async (request, response) => {
      const scope = response.locals.webhookScope as { workspaceId: string; connectionId: string };
      await receiveUpdate(services, scope, request.body);
      response.end();
    },
  );
  return router;
}
