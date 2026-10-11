import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { meController, getSettingsController, settingsController } from './workspace.controller.js';
import { mailController, saveMailController } from './workspace-mail.controller.js';
import type { MailServices } from './workspace-mail.service.js';
import { overviewController } from './workspace-overview.controller.js';
import { onboardingController } from './workspace-onboarding.controller.js';
import {
  databaseSetupValidation,
  saveDatabaseController,
  databaseController,
} from './workspace-database.controller.js';
import type { DatabaseServices } from '../../platform/db/database-setup.js';

export function workspaceRouter(
  resolveConnection: ConnectionResolver,
  mail?: MailServices,
  now: () => Date = () => new Date(),
  database?: DatabaseServices,
) {
  const router = Router();

  router.use('/database', databaseSetupValidation);

  if (database) {
    router.get('/database', databaseController(database));
    router.put('/database', saveDatabaseController(database));
  }

  router.get('/me', meController(resolveConnection));
  router.get('/overview', overviewController(resolveConnection, now));
  router.post('/onboarding/complete', onboardingController(resolveConnection, now));
  router.get('/settings', getSettingsController(resolveConnection));
  router.put('/settings', settingsController(resolveConnection));
  router.get('/settings/mail', mailController(resolveConnection));

  if (mail) {
    router.put('/settings/mail', saveMailController(resolveConnection, mail));
  }

  return router;
}
