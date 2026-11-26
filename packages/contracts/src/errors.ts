/** Typed API errors (spec §12). Never include stack traces in responses. */
export const ERROR_STATUS = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INELIGIBLE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; requestId: string; details?: unknown };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export const invalid = (message: string, details?: unknown) => new AppError('INVALID_INPUT', message, details);
export const unauthenticated = (message = 'Sign in required') => new AppError('UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission for this action') => new AppError('FORBIDDEN', message);
export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`);
export const conflict = (message: string, details?: unknown) => new AppError('CONFLICT', message, details);
export const ineligible = (message: string, details?: unknown) => new AppError('INELIGIBLE', message, details);
export const rateLimited = (message = 'Too many requests, slow down') => new AppError('RATE_LIMITED', message);

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AppError');
}
