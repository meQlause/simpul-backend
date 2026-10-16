import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { newPersonController, peopleController, personController } from './people.controller.js';

export function peopleRouter(resolveConnection: ConnectionResolver) {
  return Router()
    .get('/people', peopleController(resolveConnection))
    .post('/people', newPersonController(resolveConnection))
    .patch('/people/:personId', personController(resolveConnection));
}
