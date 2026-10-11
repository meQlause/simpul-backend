import { once } from 'node:events';
import { Router, type Response } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { parseWorkQuery, parseClosure, parseUndo, parseWorkExport } from './work.schema.js';
import { listWork, getWork, closeWork, undoCloseWork, exportWork } from './work.service.js';

type Scope = { workspaceId: string; actorId: string };

export function workRouter(resolveConnection: ConnectionResolver, now: () => Date) {
  return Router()
    .get('/work', async (request, response) => {
      const { workspaceId } = response.locals.scope as Scope;

      response.json(
        await listWork(resolveConnection, workspaceId, parseWorkQuery(request.query), now()),
      );
    })
    .get('/work/export', async (request, response) => {
      const { workspaceId } = response.locals.scope as Scope;
      const input = parseWorkExport(request.query);
      const instant = now();

      response.type('text/csv; charset=utf-8');
      response.setHeader(
        'Content-Disposition',
        'attachment; filename="simpul-summary-' + instant.toISOString().split('T')[0] + '.csv"',
      );
      const controller = new AbortController();
      const onClose = () => controller.abort();

      response.once('close', onClose);

      try {
        await exportWork(resolveConnection, { workspaceId, input, now: instant }, (chunk) =>
          writeCsv(response, chunk, controller.signal),
        );
        response.end();
      } finally {
        response.off('close', onClose);
      }
    })
    .get('/work/:displayId', async (request, response) => {
      const { workspaceId } = response.locals.scope as Scope;

      response.json({
        data: await getWork(resolveConnection, workspaceId, request.params.displayId, now()),
      });
    })
    .post('/work/:displayId/close/undo', async (request, response) => {
      const scope = response.locals.scope as Scope;

      parseUndo(request.body);
      response.json({
        data: await undoCloseWork(resolveConnection, scope, request.params.displayId, now()),
      });
    })
    .post('/work/:displayId/close', async (request, response) => {
      const scope = response.locals.scope as Scope;

      response.json({
        data: await closeWork(
          resolveConnection,
          scope,
          { ...parseClosure(request.body), displayId: request.params.displayId },
          now(),
        ),
      });
    });
}

async function writeCsv(response: Response, chunk: string, signal: AbortSignal) {
  signal.throwIfAborted();

  if (!response.write(chunk)) {
    await once(response, 'drain', { signal });
  }
}
