export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'conflict', message, details);
export const unauthorized = (message = 'Sign in to continue') => new AppError(401, 'unauthorized', message);
export const unprocessable = (message: string, details?: unknown) => new AppError(422, 'unprocessable', message, details);

/** Postgres error codes we translate. */
export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function assertUuid(value: unknown, what = 'Resource'): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw notFound(what);
  return value;
}
