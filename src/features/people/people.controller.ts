import type { RequestHandler } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { randomBytes } from 'node:crypto';
import { createPerson, listPeople, patchPerson } from './people.service.js';
import { createInvite, workspaceBotUsername } from './people-invites.service.js';
import {
  parseInviteBody,
  parseNewPerson,
  parsePersonPatch,
  personIdSchema,
} from './people.schema.js';

export function peopleController(resolveConnection: ConnectionResolver): RequestHandler {
  return async (_request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };

    response.json({
      data: await listPeople(resolveConnection, scope.workspaceId),
      meta: { botUsername: await workspaceBotUsername(resolveConnection, scope.workspaceId) },
    });
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

const CODE_BYTES = 16;

// FR-TG-12: 16 random bytes are the 32-hex code, returned once in the link.
export function inviteController(resolveConnection: ConnectionResolver): RequestHandler {
  return async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };
    const personId = personIdSchema.parse(request.params.personId);

    parseInviteBody(request.body);
    response.status(CREATED).json({
      data: await createInvite(resolveConnection, scope, personId, {
        now: new Date(),
        code: randomBytes(CODE_BYTES).toString('hex'),
      }),
    });
  };
}
