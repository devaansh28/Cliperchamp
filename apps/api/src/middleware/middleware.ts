import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { pinoHttp } from 'pino-http';
import { z, ZodError } from 'zod';
import {
  ProviderError,
  ProviderNotConfiguredError,
  QuotaExceededError,
  StorageError,
  type Logger,
} from '@clipforge/server-core';
import type { ApiErrorBody } from '@clipforge/shared';
import { InvalidTokenError, type AuthUser, type TokenVerifier } from '../auth/verifier.js';
import { AppError, pgCode, unauthorized } from '../utils/errors.js';
import type { Metrics } from '../services/metrics.js';

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
    user?: AuthUser;
  }
}

export function requestLogger(log: Logger): RequestHandler {
  return pinoHttp({
    logger: log,
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const id = typeof incoming === 'string' && /^[\w-]{8,64}$/u.test(incoming) ? incoming : randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
    // Never log query strings: signed URL tokens live there.
    serializers: {
      req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, path: req.url.split('?')[0] }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    autoLogging: { ignore: (req) => req.url === '/health' },
  }) as unknown as RequestHandler;
}

export function cors(origins: string[]): RequestHandler {
  const allowed = new Set(origins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type, idempotency-key, x-request-id');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('access-control-expose-headers', 'x-request-id');
      res.setHeader('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('cross-origin-resource-policy', 'cross-origin');
    next();
  };
}

export function requireAuth(verifier: TokenVerifier): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return next(unauthorized());
    try {
      req.user = await verifier.verify(header.slice(7));
      next();
    } catch (err) {
      next(err instanceof InvalidTokenError ? unauthorized('Your session has expired. Please sign in again.') : err);
    }
  };
}

export function userId(req: Request): string {
  if (!req.user) throw unauthorized();
  return req.user.id;
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

function body(code: string, message: string, requestId: string, details?: unknown): ApiErrorBody {
  return { error: { code, message, requestId, ...(details === undefined ? {} : { details }) } };
}

/** Converts known errors into safe responses. Internal details are logged, never returned. */
export function errorHandler(log: Logger, metrics: Metrics) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const id = req.id ?? 'unknown';
    let status = 500;
    let payload: ApiErrorBody;
    if (err instanceof AppError) {
      status = err.status;
      payload = body(err.code, err.message, id, err.details);
    } else if (err instanceof ZodError) {
      status = 400;
      payload = body('validation_error', 'Some fields are invalid', id, err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    } else if (err instanceof ProviderNotConfiguredError) {
      status = 503;
      payload = body('integration_not_configured', err.hint, id, { capability: err.capability });
    } else if (err instanceof ProviderError) {
      status = err.transient ? 503 : 502;
      payload = body('provider_error', err.userMessage, id);
      log.warn({ err: { name: err.name, message: err.message }, reqId: id }, 'provider error');
    } else if (err instanceof QuotaExceededError) {
      status = 402;
      payload = body('quota_exceeded', `You have reached the demo limit for ${err.kind.replace('_', ' ')} (${err.limit} ${err.unit}).`, id, {
        kind: err.kind,
        used: err.used,
        limit: err.limit,
      });
    } else if (err instanceof StorageError) {
      status = err.transient ? 503 : 404;
      payload = body('storage_error', err.transient ? 'Storage is temporarily unavailable' : 'File not found', id);
      if (err.transient) metrics.storageFailures += 1;
    } else if (typeof err === 'object' && err !== null && 'type' in err && (err as { type: string }).type === 'entity.too.large') {
      status = 413;
      payload = body('payload_too_large', 'Request body is too large', id);
    } else if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
      status = 413;
      payload = body('file_too_large', 'File is larger than the upload limit', id);
    } else if (pgCode(err) === '23503') {
      status = 409;
      payload = body('conflict', 'A referenced item no longer exists or is still in use', id);
    } else if (pgCode(err) === '42501') {
      status = 404;
      payload = body('not_found', 'Resource not found', id);
    } else {
      payload = body('internal_error', 'Something went wrong. Please try again.', id);
    }
    if (status >= 500) {
      metrics.apiErrors += 1;
      log.error({ err, reqId: id }, 'request failed');
    }
    res.status(status).json(payload);
  };
}
