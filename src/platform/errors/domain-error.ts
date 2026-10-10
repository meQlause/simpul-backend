const errors = {
  'E-TG-CREDENTIAL-BOT-MISMATCH': {
    status: 422,
    message: 'This token belongs to a different bot.',
  },
  'E-TG-READINESS-INCOMPLETE': {
    status: 422,
    message: 'Complete the readiness checks before activating monitoring.',
  },
  'E-TG-VERIFICATION-EXPIRED': {
    status: 409,
    message: 'The setup changed or the check expired. Run the checks again.',
  },
  'E-TG-VERSION-CONFLICT': {
    status: 409,
    message: 'This configuration was changed. Reload before saving.',
  },
  'E-TG-ACTIVATION-FAILED': {
    status: 502,
    message: 'Monitoring could not be activated. Review the setup checks.',
  },
  'E-TG-GROUP-UNAVAILABLE': {
    status: 422,
    message: 'The group could not be accessed. Check the Chat ID and add the bot.',
  },
  'E-TG-SESSION-EXPIRED': {
    status: 410,
    message: 'This connection code has expired. Generate a new code.',
  },
  'E-WEBHOOK-FORBIDDEN': { status: 403, message: '' },
  'E-TG-CHANNEL-DUPLICATE': {
    status: 409,
    message: 'This group is already configured in this workspace.',
  },
  'E-TG-CHAT-TYPE-UNSUPPORTED': {
    status: 422,
    message: 'Only Telegram groups and supergroups are supported.',
  },
  'E-TG-BOT-IN-USE': {
    status: 409,
    message: 'This bot is already assigned to another workspace.',
  },
  'E-TG-WEBHOOK-CONFLICT': {
    status: 409,
    message: 'This bot is connected to another application. Use a dedicated bot.',
  },
  'E-TG-IDEMPOTENCY-CONFLICT': {
    status: 409,
    message: 'Use a new request key for this changed operation.',
  },
  'E-TG-INPUT-INVALID': { status: 422, message: 'Check the required fields.' },
  'E-TG-TOKEN-INVALID': {
    status: 422,
    message: 'The bot token could not be verified. Check it in BotFather.',
  },
  'E-TG-SETUP-TIMEOUT': {
    status: 504,
    message: 'Telegram did not respond in time. Your group is not active.',
  },
  'E-MAIL-CONNECTION-FAILED': {
    status: 422,
    message: 'The mail server could not be reached with these details. Nothing was saved.',
  },
  'E-VALIDATION': { status: 422, message: 'Check the highlighted fields.' },
  'E-SETTINGS-QUIET-HOURS-EQUAL': { status: 422, message: 'Choose different start and end times.' },
  'E-AUTH-REQUIRED': { status: 401, message: 'Your session has ended. Sign in to continue.' },
  'E-FORBIDDEN': { status: 403, message: 'Only workspace admins can open this panel.' },
  'E-NOT-FOUND': { status: 404, message: 'This page is unavailable. Return to Home to continue.' },
  'E-INTERNAL': {
    status: 500,
    message:
      'Workspace could not be loaded. Your settings were not changed. Retry when the service is available.',
  },
} as const;

export class DomainError extends Error {
  readonly status: number;

  constructor(
    readonly code: keyof typeof errors,
    readonly details?: {
      field: string;
      issue: 'invalid' | 'unknown' | 'required';
      message?: string;
    }[],
  ) {
    super(errors[code].message);
    this.name = 'DomainError';
    this.status = errors[code].status;
  }
}
