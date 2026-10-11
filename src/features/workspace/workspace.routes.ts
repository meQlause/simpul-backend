import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { meController, getSettingsController, settingsController } from './workspace.controller.js';
import { mailController, saveMailController } from './workspace-mail.controller.js';
import type { MailServices } from './workspace-mail.service.js';
import { overviewController } from './workspace-overview.controller.js';

export function workspaceRouter(
  resolveConnection: ConnectionResolver,
  mail?: MailServices,
  now: () => Date = () => new Date(),
) {
  const router = Router();

  router.get('/me', meController(resolveConnection));
  router.get('/overview', overviewController(resolveConnection, now));
  router.get('/settings', getSettingsController(resolveConnection));
  router.put('/settings', settingsController(resolveConnection));
  router.get('/settings/mail', mailController(resolveConnection));

  if (mail) {
    router.put('/settings/mail', saveMailController(resolveConnection, mail));
  }

  return router;
}
