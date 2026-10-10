import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { peopleController, personController } from './people.controller.js';

export function peopleRouter(resolveConnection: ConnectionResolver) {
  return Router()
    .get('/people', peopleController(resolveConnection))
    .patch('/people/:personId', personController(resolveConnection));
}
