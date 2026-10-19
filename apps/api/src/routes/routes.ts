import os from 'node:os';
import path from 'node:path';
import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { LocalStorage} from '@clipforge/server-core';
import { usageSummary, withUserTx, type ServerContext } from '@clipforge/server-core';
import {
  CreateProjectSchema,
  CreateRenderSchema,
  CredentialsSchema,
  MediaImportSchema,
  PublishRequestSchema,
  SOCIAL_PLATFORMS,
  SaveTimelineSchema,
  ScriptRequestSchema,
  UpdateProjectSchema,
  VoicePreviewSchema,
  VoiceRequestSchema,
  buildEstimatedCaptions,
  type IntegrationStatus,
} from '@clipforge/shared';
import { randomUUID } from 'node:crypto';
import type { LocalAuthService } from '../auth/local-auth.js';
import { parse, userId } from '../middleware/middleware.js';
import { mediaRepository } from '../repositories/media-repository.js';
import { projectRepository } from '../repositories/project-repository.js';
import type { MediaService } from '../services/media-service.js';
import type { ProjectService } from '../services/project-service.js';
import type { RenderService } from '../services/render-service.js';
import type { SocialService } from '../services/social-service.js';
import { narrationText, type ScriptService } from '../services/script-service.js';
import type { VoiceService } from '../services/voice-service.js';
import { AppError, assertUuid, badRequest, notFound } from '../utils/errors.js';

export interface Services {
  projects: ProjectService;
  scripts: ScriptService;
  media: MediaService;
  voice: VoiceService;
  renders: RenderService;
  social: SocialService;
  localAuth: LocalAuthService | null;
}

const ListQuery = z.object({
  search: z.string().trim().max(120).optional(),
  sort: z.enum(['updated', 'created', 'name']).default('updated'),
});

// ---------------------------------------------------------------------------
// Local (development) auth routes. Supabase mode signs in from the browser instead.
// ---------------------------------------------------------------------------
export function localAuthRoutes(localAuth: LocalAuthService, authLimiter: RequestHandler, requireAuth: RequestHandler): Router {
  const r = Router();
  const Refresh = z.object({ refreshToken: z.string().min(10).max(200) });
  r.post('/register', authLimiter, async (req, res) => {
    const { email, password } = parse(CredentialsSchema, req.body);
    res.status(201).json(await localAuth.register(email, password));
  });
  r.post('/login', authLimiter, async (req, res) => {
    const { email, password } = parse(CredentialsSchema, req.body);
    res.json(await localAuth.login(email, password));
  });
  r.post('/refresh', authLimiter, async (req, res) => {
    res.json(await localAuth.refresh(parse(Refresh, req.body).refreshToken));
  });
  r.post('/logout', async (req, res) => {
    const body = Refresh.safeParse(req.body);
    if (body.success) await localAuth.logout(body.data.refreshToken);
    res.status(204).end();
  });
  r.post('/password', requireAuth, authLimiter, async (req, res) => {
    const { currentPassword, newPassword } = parse(
      z.object({ currentPassword: z.string().min(1).max(128), newPassword: CredentialsSchema.shape.password }),
      req.body,
    );
    await localAuth.changePassword(userId(req), currentPassword, newPassword);
    res.status(204).end();
  });
  return r;
}

// ---------------------------------------------------------------------------
// Authenticated API
// ---------------------------------------------------------------------------
export function apiRoutes(ctx: ServerContext, s: Services, limits: { expensive: RequestHandler }): Router {
  const r = Router();
  const upload = multer({
    dest: path.join(os.tmpdir(), 'clipforge-uploads'),
    limits: { fileSize: ctx.env.UPLOAD_MAX_FILE_SIZE_MB * 1024 * 1024, files: 1, fields: 5 },
  });

  // Profile -------------------------------------------------------------------
  r.get('/me', async (req, res) => {
    const id = userId(req);
    const profile = await withUserTx(ctx.pool, id, (db) =>
      db.query<{ display_name: string | null; created_at: Date }>('select display_name, created_at from public.profiles where id = $1', [id]),
    );
    res.json({ id, email: req.user?.email ?? null, displayName: profile.rows[0]?.display_name ?? null });
  });
  r.patch('/me', async (req, res) => {
    const { displayName } = parse(z.object({ displayName: z.string().trim().min(1).max(80).nullable() }), req.body);
    const id = userId(req);
    await withUserTx(ctx.pool, id, (db) => db.query('update public.profiles set display_name = $2 where id = $1', [id, displayName]));
    res.json({ id, email: req.user?.email ?? null, displayName });
  });

  r.get('/integrations', (_req, res) => {
    const status: IntegrationStatus = {
      llm: { configured: ctx.llm.configured, provider: ctx.llm.provider, model: ctx.llm.model },
      tts: { configured: ctx.tts.configured, provider: ctx.tts.provider, voices: ctx.tts.voices() },
      media: { configured: ctx.media.configured, provider: ctx.media.provider },
      alignment: { configured: ctx.alignment.configured, provider: ctx.alignment.provider },
      auth: { provider: ctx.env.AUTH_PROVIDER },
    };
    res.json(status);
  });

  r.get('/usage', async (req, res) => {
    const id = userId(req);
    res.json(await withUserTx(ctx.pool, id, (db) => usageSummary(db, ctx.env, id)));
  });

  // Projects ------------------------------------------------------------------
  r.get('/projects', async (req, res) => {
    res.json(await s.projects.list(userId(req), parse(ListQuery, req.query)));
  });
  r.post('/projects', async (req, res) => {
    const body = parse(CreateProjectSchema, req.body);
    res.status(201).json(await s.projects.create(userId(req), body.name, body.template));
  });
  r.get('/projects/:id', async (req, res) => {
    res.json(await s.projects.get(userId(req), assertUuid(req.params.id, 'Project')));
  });
  r.patch('/projects/:id', async (req, res) => {
    const body = parse(UpdateProjectSchema, req.body);
    res.json(await s.projects.update(userId(req), assertUuid(req.params.id, 'Project'), body));
  });
  r.put('/projects/:id/timeline', async (req, res) => {
    const body = parse(SaveTimelineSchema, req.body);
    res.json(await s.projects.saveTimeline(userId(req), assertUuid(req.params.id, 'Project'), body.timeline, body.revision));
  });
  r.post('/projects/:id/duplicate', async (req, res) => {
    res.status(201).json(await s.projects.duplicate(userId(req), assertUuid(req.params.id, 'Project')));
  });
  r.delete('/projects/:id', async (req, res) => {
    await s.projects.delete(userId(req), assertUuid(req.params.id, 'Project'));
    res.status(204).end();
  });

  // Script --------------------------------------------------------------------
  r.post('/projects/:id/script/generate', limits.expensive, async (req, res) => {
    const input = parse(ScriptRequestSchema, req.body);
    res.json(await s.scripts.generate(userId(req), assertUuid(req.params.id, 'Project'), input));
  });

  // Captions: build estimated captions from the script (and narration length when known),
  // or align against narration audio when an alignment provider is configured.
  r.post('/projects/:id/captions/from-script', async (req, res) => {
    const id = userId(req);
    const projectId = assertUuid(req.params.id, 'Project');
    const body = parse(
      z.object({ narrationAssetId: z.string().uuid().optional(), maxWordsPerSegment: z.number().int().min(1).max(12).default(4), startMs: z.number().int().min(0).default(0) }),
      req.body ?? {},
    );
    const result = await withUserTx(ctx.pool, id, async (db) => {
      const project = await projectRepository.getRow(db, id, projectId);
      if (!project) throw notFound('Project');
      if (!project.script) throw badRequest('Write or generate a script first');
      let totalDurationMs: number | undefined;
      if (body.narrationAssetId) {
        const asset = await mediaRepository.get(db, id, body.narrationAssetId);
        if (!asset) throw notFound('Narration');
        totalDurationMs = asset.duration_ms ?? undefined;
      }
      return { text: narrationText(project.script), totalDurationMs };
    });
    const captions = buildEstimatedCaptions(result.text, {
      totalDurationMs: result.totalDurationMs,
      startMs: body.startMs,
      maxWordsPerSegment: body.maxWordsPerSegment,
      newId: randomUUID,
    });
    res.json({ captions, timing: 'estimated', basedOnAudioDuration: result.totalDurationMs !== undefined });
  });

  r.post('/projects/:id/captions/align', limits.expensive, async (req, res) => {
    const id = userId(req);
    const { narrationAssetId, maxWordsPerSegment } = parse(
      z.object({ narrationAssetId: z.string().uuid(), maxWordsPerSegment: z.number().int().min(1).max(12).default(4) }),
      req.body,
    );
    const asset = await withUserTx(ctx.pool, id, (db) => mediaRepository.get(db, id, narrationAssetId));
    if (!asset || asset.kind !== 'audio') throw notFound('Narration');
    if (!ctx.alignment.configured) await ctx.alignment.transcribeWords('');
    const tmp = path.join(os.tmpdir(), `cf-align-${randomUUID()}`);
    try {
      await ctx.storage.getToFile(asset.storage_path, tmp);
      const words = await ctx.alignment.transcribeWords(tmp);
      const captions = [];
      for (let i = 0; i < words.length; i += maxWordsPerSegment) {
        const chunk = words.slice(i, i + maxWordsPerSegment);
        captions.push({
          id: randomUUID(),
          startMs: chunk[0]!.startMs,
          endMs: chunk[chunk.length - 1]!.endMs,
          text: chunk.map((w) => w.text).join(' '),
          words: chunk,
          timingSource: 'aligned' as const,
        });
      }
      res.json({ captions, timing: 'aligned' });
    } finally {
      await import('node:fs/promises').then((fs) => fs.rm(tmp, { force: true }));
    }
  });

  // Media ---------------------------------------------------------------------
  r.get('/media', async (req, res) => {
    const { projectId } = parse(z.object({ projectId: z.string().uuid().optional() }), req.query);
    res.json(await s.media.list(userId(req), projectId ?? null));
  });
  r.post('/media', upload.single('file'), async (req, res) => {
    if (!req.file) throw badRequest('Attach a file in the "file" field');
    const { projectId } = parse(z.object({ projectId: z.string().uuid().optional() }), req.body ?? {});
    res.status(201).json(await s.media.upload(userId(req), req.file, projectId ?? null));
  });
  r.get('/media/stock/search', limits.expensive, async (req, res) => {
    const { q } = parse(z.object({ q: z.string().trim().min(2).max(100) }), req.query);
    res.json(await ctx.media.search(q, { orientation: 'portrait', perPage: 12 }));
  });
  r.post('/media/stock/import', limits.expensive, async (req, res) => {
    const body = parse(MediaImportSchema.extend({ projectId: z.string().uuid().optional() }), req.body);
    res.status(201).json(await s.media.importStock(userId(req), body.projectId ?? null, body.externalId));
  });
  r.get('/media/:id', async (req, res) => {
    res.json(await s.media.get(userId(req), assertUuid(req.params.id, 'Media')));
  });
  r.delete('/media/:id', async (req, res) => {
    await s.media.delete(userId(req), assertUuid(req.params.id, 'Media'));
    res.status(204).end();
  });

  // Scene → media suggestions from the script.
  r.get('/projects/:id/media-suggestions', limits.expensive, async (req, res) => {
    const id = userId(req);
    const project = await withUserTx(ctx.pool, id, (db) => projectRepository.getRow(db, id, assertUuid(req.params.id, 'Project')));
    if (!project) throw notFound('Project');
    if (!project.script) throw badRequest('Write or generate a script first');
    const scenes = project.script.segments.map((seg, index) => ({
      index,
      query: (seg.scene || seg.narration).split(/\s+/u).slice(0, 6).join(' '),
    }));
    if (!ctx.media.configured) {
      res.json({ configured: false, scenes: scenes.map((sc) => ({ ...sc, results: [] })) });
      return;
    }
    const withResults = [];
    for (const scene of scenes.slice(0, 8)) {
      withResults.push({ ...scene, results: await ctx.media.search(scene.query, { orientation: 'portrait', perPage: 4 }) });
    }
    res.json({ configured: true, scenes: withResults });
  });

  // Voice ---------------------------------------------------------------------
  r.get('/voices', (_req, res) => {
    res.json({ configured: ctx.tts.configured, provider: ctx.tts.provider, voices: ctx.tts.voices() });
  });
  r.post('/voice/preview', limits.expensive, async (req, res) => {
    const body = parse(VoicePreviewSchema, req.body);
    const { audio, mimeType } = await s.voice.preview(body.text, body.voiceId, body.speed);
    res.setHeader('content-type', mimeType);
    res.setHeader('cache-control', 'no-store');
    res.send(audio);
  });
  r.post('/projects/:id/voiceover', limits.expensive, async (req, res) => {
    const body = parse(VoiceRequestSchema.partial({ text: true }), req.body);
    res.status(202).json(await s.voice.generate(userId(req), assertUuid(req.params.id, 'Project'), body));
  });

  // Renders -------------------------------------------------------------------
  r.post('/projects/:id/renders', limits.expensive, async (req, res) => {
    const body = parse(CreateRenderSchema, req.body ?? {});
    const key = req.header('idempotency-key') ?? null;
    if (key && !/^[\w-]{8,100}$/u.test(key)) throw badRequest('Invalid Idempotency-Key header');
    const { job, created } = await s.renders.create(userId(req), assertUuid(req.params.id, 'Project'), { profile: body.profile, idempotencyKey: key });
    res.status(created ? 202 : 200).json(job);
  });
  r.get('/projects/:id/renders', async (req, res) => {
    res.json(await s.renders.list(userId(req), assertUuid(req.params.id, 'Project')));
  });
  r.get('/renders/:id', async (req, res) => {
    res.json(await s.renders.get(userId(req), assertUuid(req.params.id, 'Render')));
  });
  r.post('/renders/:id/cancel', async (req, res) => {
    res.json(await s.renders.cancel(userId(req), assertUuid(req.params.id, 'Render')));
  });
  r.get('/renders/:id/download', async (req, res) => {
    res.json(await s.renders.downloadUrl(userId(req), assertUuid(req.params.id, 'Render')));
  });
  r.get('/renders/:id/playback', async (req, res) => {
    res.json(await s.renders.playbackUrl(userId(req), assertUuid(req.params.id, 'Render')));
  });

  // Social accounts and publishing -------------------------------------------
  const Platform = z.object({ platform: z.enum(SOCIAL_PLATFORMS) });
  r.get('/social/accounts', async (req, res) => {
    res.json({ platforms: s.social.platforms(), accounts: await s.social.listAccounts(userId(req)) });
  });
  r.post('/social/:platform/connect', limits.expensive, async (req, res) => {
    const { platform } = parse(Platform, req.params);
    res.json(await s.social.startConnect(userId(req), platform));
  });
  r.delete('/social/accounts/:id', async (req, res) => {
    await s.social.disconnect(userId(req), assertUuid(req.params.id, 'Account'));
    res.status(204).end();
  });
  r.post('/renders/:id/publish', limits.expensive, async (req, res) => {
    const body = parse(PublishRequestSchema, req.body);
    const result = await s.social.publish(userId(req), assertUuid(req.params.id, 'Render'), body);
    res.status(result.created.length ? 202 : 200).json(result);
  });
  r.get('/renders/:id/publications', async (req, res) => {
    res.json(await s.social.listForRender(userId(req), assertUuid(req.params.id, 'Render')));
  });
  r.get('/projects/:id/publications', async (req, res) => {
    res.json(await s.social.listForProject(userId(req), assertUuid(req.params.id, 'Project')));
  });
  r.post('/publications/:id/cancel', async (req, res) => {
    res.json(await s.social.cancel(userId(req), assertUuid(req.params.id, 'Post')));
  });
  r.post('/publications/:id/retry', limits.expensive, async (req, res) => {
    res.json(await s.social.retry(userId(req), assertUuid(req.params.id, 'Post')));
  });

  return r;
}

/**
 * OAuth callbacks. Platforms redirect the browser here (no API token), so the one-time state
 * stored at connect time is what ties the callback to the user. Always redirects back to the app.
 */
export function socialOAuthRoutes(ctx: ServerContext, social: SocialService): Router {
  const r = Router();
  const webOrigin = ctx.env.WEB_ORIGIN.split(',')[0]!.trim().replace(/\/$/u, '');
  r.get('/:platform/callback', async (req, res) => {
    const back = (params: Record<string, string>) => res.redirect(303, `${webOrigin}/app/settings?${new URLSearchParams(params).toString()}#accounts`);
    const platform = z.enum(SOCIAL_PLATFORMS).safeParse(req.params.platform);
    const q = z.object({ code: z.string().min(1).max(2000).optional(), state: z.string().min(10).max(200).optional(), error: z.string().max(200).optional() }).safeParse(req.query);
    if (!platform.success || !q.success) return back({ social: 'error', message: 'The connection response was not valid.' });
    if (q.data.error || !q.data.code || !q.data.state) {
      return back({ social: 'error', platform: platform.data, message: q.data.error === 'access_denied' ? 'Connection cancelled.' : 'The platform did not approve the connection.' });
    }
    try {
      const account = await social.completeConnect(platform.data, q.data.code, q.data.state);
      return back({ social: 'connected', platform: platform.data, account: account.displayName ?? '' });
    } catch (err) {
      const message = err instanceof AppError ? err.message : (err as { userMessage?: string }).userMessage ?? 'Could not connect the account. Please try again.';
      ctx.log.warn({ err: { name: (err as Error).name, message: (err as Error).message }, platform: platform.data }, 'social connect failed');
      return back({ social: 'error', platform: platform.data, message });
    }
  });
  return r;
}

/** Serves local-storage objects for valid, unexpired signed URLs only. Supports Range for video seeking. */
export function localFileRoutes(storage: LocalStorage): Router {
  const r = Router();
  r.get('/*key', (req, res, next) => {
    const key = (req.params as { key: string[] }).key.join('/');
    const q = req.query as Record<string, string | undefined>;
    const file = storage.verifySignedRequest(key, q.exp ?? '', q.sig ?? '', q.dl ?? '');
    if (!file) return next(new AppError(403, 'invalid_signature', 'This link is invalid or has expired'));
    res.setHeader('cache-control', 'private, max-age=300');
    if (q.dl) res.attachment(q.dl.replace(/[^\w.-]/gu, '_'));
    res.sendFile(file, { dotfiles: 'deny', acceptRanges: true }, (err) => {
      if (err && !res.headersSent) next(new AppError(404, 'not_found', 'File not found'));
    });
  });
  return r;
}
