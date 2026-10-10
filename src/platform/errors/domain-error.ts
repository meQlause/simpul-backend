const errors = {
  'E-NOT-FOUND': { status: 404, message: 'This page is unavailable. Return to Home to continue.' },
  'E-INTERNAL': {
    status: 500,
    message:
      'Workspace could not be loaded. Your settings were not changed. Retry when the service is available.',
  },
} as const;

export class DomainError extends Error {
  readonly status: number;

  constructor(readonly code: keyof typeof errors) {
    super(errors[code].message);
    this.name = 'DomainError';
    this.status = errors[code].status;
  }
}
