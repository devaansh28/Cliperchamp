import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import { LocalStorage, type ServerContext } from '@clipforge/server-core';
import { QUEUE_NAMES } from '@clipforge/shared';
import { LocalAuthService } from './auth/local-auth.js';
import { createTokenVerifier, type TokenVerifier } from './auth/verifier.js';
import { cors, errorHandler, requestLogger, requireAuth, securityHeaders } from './middleware/middleware.js';
import { apiRoutes, localAuthRoutes, localFileRoutes, socialOAuthRoutes, type Services } from './routes/routes.js';
import { buildOpenApi } from './schemas/openapi.js';
import { MediaService } from './services/media-service.js';
import { createMetrics, renderStats, type Metrics } from './services/metrics.js';
import { ProjectService } from './services/project-service.js';
import { RenderService } from './services/render-service.js';
import { ScriptService } from './services/script-service.js';
import { SocialService } from './services/social-service.js';
import { VoiceService } from './services/voice-service.js';
import { AppError } from './utils/errors.js';

export interface AppOptions {
  verifier?: TokenVerifier;
  /** Disable rate limits (tests). */
  disableRateLimits?: boolean;
}

export function createApp(ctx: ServerContext, opts: AppOptions = {}): { app: Express; metrics: Metrics; services: Services } {
  const app = express();
  const metrics = createMetrics();
  const verifier = opts.verifier ?? createTokenVerifier(ctx.env);
  const services: Services = {
    projects: new ProjectService(ctx),
    scripts: new ScriptService(ctx),
    media: new MediaService(ctx),
    voice: new VoiceService(ctx),
    renders: new RenderService(ctx),
    social: new SocialService(ctx),
    localAuth: ctx.env.AUTH_PROVIDER === 'local' ? new LocalAuthService(ctx.pool, ctx.env.AUTH_JWT_SECRET!) : null,
  };

  app.disable('x-powered-by');
  if (ctx.env.TRUST_PROXY) app.set('trust proxy', 1);
  app.use(requestLogger(ctx.log));
  app.use((_req, _res, next) => {
    metrics.requests += 1;
    next();
  });
  app.use(securityHeaders());
  app.use(cors(ctx.env.WEB_ORIGIN.split(',').map((o) => o.trim())));
  app.use(express.json({ limit: '2mb' }));

  const noop: express.RequestHandler = (_req, _res, next) => next();
  const limiter = (limit: number) =>
    opts.disableRateLimits
      ? noop
      : rateLimit({
          windowMs: 60_000,
          limit,
          standardHeaders: 'draft-8',
          legacyHeaders: false,
          handler: (_req, _res, next) => next(new AppError(429, 'rate_limited', 'Too many requests. Please slow down.')),
        });

  // Health and metrics ------------------------------------------------------
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/health/ready', async (_req, res) => {
    try {
      await ctx.pool.query('select 1');
      const queueDepth = await ctx.queue.queueSize(QUEUE_NAMES.renderVideo);
      res.json({ status: 'ready', queueDepth });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  app.get('/health/metrics', async (req, res) => {
    // Without a token, metrics are only exposed outside production.
    const token = ctx.env.METRICS_TOKEN;
    if (!token && ctx.env.NODE_ENV === 'production') {
      res.status(404).end();
      return;
    }
    if (token && req.header('authorization') !== `Bearer ${token}`) {
      res.status(401).end();
      return;
    }
    const queues: Record<string, number> = {};
    for (const name of Object.values(QUEUE_NAMES)) queues[name] = await ctx.queue.queueSize(name).catch(() => -1);
    res.json({
      uptimeSeconds: Math.round((Date.now() - metrics.startedAt) / 1000),
      requests: metrics.requests,
      apiErrors5xx: metrics.apiErrors,
      storageFailures: metrics.storageFailures,
      queueDepth: queues,
      renders: await renderStats(ctx.pool),
    });
  });
  app.get('/api/openapi.json', (_req, res) => {
    res.json(buildOpenApi(ctx.env.API_BASE_URL));
  });

  const auth = requireAuth(verifier);
  if (services.localAuth) app.use('/api/auth', localAuthRoutes(services.localAuth, limiter(20), auth));
  if (ctx.storage instanceof LocalStorage) app.use('/files', localFileRoutes(ctx.storage));

  app.use('/api/social/oauth', limiter(30), socialOAuthRoutes(ctx, services.social));
  app.use('/api', limiter(ctx.env.RATE_LIMIT_PER_MINUTE), auth, apiRoutes(ctx, services, { expensive: limiter(30) }));

  app.use((_req, _res, next) => next(new AppError(404, 'not_found', 'Route not found')));
  app.use(errorHandler(ctx.log, metrics));
  return { app, metrics, services };
}
