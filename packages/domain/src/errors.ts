/** Stable, machine-readable error codes. `status` is the HTTP mapping used by the API layer (spec §12). */
export const ERROR_STATUS = {
  VALIDATION: 422,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  INVALID_TOKEN: 403,
  SLOT_TAKEN: 409,
  SLOT_NOT_OFFERED: 422,
  HOLD_EXPIRED: 410,
  HOLD_NOT_ACTIVE: 409,
  IDEMPOTENCY_MISMATCH: 409,
  INVALID_TRANSITION: 409,
  CANCELLATION_WINDOW_CLOSED: 422,
  RULE_VIOLATION: 422,
  CONFLICT: 409,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

export const isDomainError = (e: unknown, code?: ErrorCode): e is DomainError =>
  e instanceof DomainError && (code === undefined || e.code === code);
