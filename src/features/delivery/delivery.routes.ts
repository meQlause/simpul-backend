import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { recipientPreview } from './delivery-preview.service.js';

export function deliveryRouter(resolveConnection: ConnectionResolver, now: () => Date) {
  return Router().get('/previews/recipient', async (_request, response) => {
    const { workspaceId } = response.locals.scope as { workspaceId: string };

    response.json({ data: await recipientPreview(resolveConnection, workspaceId, now()) });
  });
}
