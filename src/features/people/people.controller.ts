import type { RequestHandler } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { createPerson, listPeople, patchPerson } from './people.service.js';
import { parseNewPerson, parsePersonPatch, personIdSchema } from './people.schema.js';

export function peopleController(resolveConnection: ConnectionResolver): RequestHandler {
  return async (_request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };

    response.json({ data: await listPeople(resolveConnection, scope.workspaceId) });
  };
}

export function personController(resolveConnection: ConnectionResolver): RequestHandler {
  return async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };
    const personId = personIdSchema.parse(request.params.personId);

    response.json({
      data: await patchPerson(resolveConnection, scope, personId, parsePersonPatch(request.body)),
    });
  };
}

const CREATED = 201;

export function newPersonController(resolveConnection: ConnectionResolver): RequestHandler {
  return async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };

    response
      .status(CREATED)
      .json({ data: await createPerson(resolveConnection, scope, parseNewPerson(request.body)) });
  };
}
