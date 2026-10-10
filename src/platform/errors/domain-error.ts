const errors = {
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
