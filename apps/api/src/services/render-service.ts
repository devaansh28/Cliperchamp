import {
  assertWithinQuota,
  withServiceTx,
  withUserTx,
  type RenderSnapshot,
  type ServerContext,
} from '@clipforge/server-core';
import {
  DEFAULT_OUTPUT_PROFILE,
  PREVIEW_OUTPUT_PROFILE,
  QUEUE_NAMES,
  timelineDurationMs,
  type RenderJob,
} from '@clipforge/shared';
import { mediaRepository } from '../repositories/media-repository.js';
import { projectRepository } from '../repositories/project-repository.js';
import { renderRepository, toRenderJob } from '../repositories/render-repository.js';
import { AppError, notFound, unprocessable } from '../utils/errors.js';

export class RenderService {
  constructor(private readonly ctx: ServerContext) {}

  /**
   * Validate the saved project, snapshot it and enqueue a render. Concurrent or repeated
   * requests return the already-active job instead of starting a duplicate.
   */
  async create(
    userId: string,
    projectId: string,
    opts: { profile: 'full' | 'preview'; idempotencyKey: string | null },
  ): Promise<{ job: RenderJob; created: boolean }> {
    const result = await withUserTx(this.ctx.pool, userId, async (db) => {
      if (opts.idempotencyKey) {
        const existing = await renderRepository.findByIdempotencyKey(db, userId, opts.idempotencyKey);
        if (existing) return { row: existing, created: false };
      }
      const project = await projectRepository.getRow(db, userId, projectId);
      if (!project) throw notFound('Project');
      const active = await renderRepository.findActive(db, projectId);
      if (active) return { row: active, created: false };

      const timeline = await projectRepository.getTimeline(db, project);
      const durationMs = timelineDurationMs(timeline);
      if (durationMs > this.ctx.env.RENDER_MAX_DURATION_SECONDS * 1000) {
        throw unprocessable(`Videos can be at most ${this.ctx.env.RENDER_MAX_DURATION_SECONDS} seconds long`);
      }
      if (timeline.clips.length === 0 && timeline.captions.length === 0) {
        throw unprocessable('Add media or captions before rendering');
      }
      const ids = [...new Set(timeline.clips.map((c) => c.assetId))];
      const assets = await mediaRepository.getMany(db, userId, ids);
      if (assets.length !== ids.length) throw unprocessable('Some media in the timeline is no longer available');
      const notReady = assets.filter((a) => a.status !== 'ready');
      if (notReady.length) {
        throw unprocessable('Some media is still processing or failed to process', { assetIds: notReady.map((a) => a.id) });
      }

      await assertWithinQuota(db, this.ctx.env, userId, 'export', 1);
      await assertWithinQuota(db, this.ctx.env, userId, 'render_seconds', Math.ceil(durationMs / 1000));

      const output = opts.profile === 'preview' ? { ...PREVIEW_OUTPUT_PROFILE } : { ...DEFAULT_OUTPUT_PROFILE, ...timeline.output, width: 1080, height: 1920 };
      const snapshot: RenderSnapshot = {
        version: 1,
        timeline: { ...timeline, output },
        output,
        assets: assets.map((a) => ({
          id: a.id,
          kind: a.kind,
          storagePath: a.storage_path,
          mimeType: a.mime_type,
          durationMs: a.duration_ms,
          width: a.width,
          height: a.height,
        })),
      };
      const row = await renderRepository.insert(db, { projectId, userId, profile: opts.profile, idempotencyKey: opts.idempotencyKey, snapshot });
      if (!row) {
        // Lost a race with a concurrent request; return the job that won.
        const winner =
          (opts.idempotencyKey && (await renderRepository.findByIdempotencyKey(db, userId, opts.idempotencyKey))) ||
          (await renderRepository.findActive(db, projectId));
        if (!winner) throw new AppError(409, 'conflict', 'A render was just started. Refresh to see it.');
        return { row: winner, created: false };
      }
      return { row, created: true };
    });

    if (result.created) {
      try {
        await this.ctx.queue.send(QUEUE_NAMES.renderVideo, { renderJobId: result.row.id }, { singletonKey: result.row.id });
      } catch (err) {
        await withServiceTx(this.ctx.pool, (db) =>
          db.query(
            `update public.render_jobs set status = 'failed', error_category = 'internal',
               error_message = 'The render could not be queued. Please try again.', completed_at = now() where id = $1`,
            [result.row.id],
          ),
        );
        throw err;
      }
    }
    return { job: toRenderJob(result.row), created: result.created };
  }

  async list(userId: string, projectId: string): Promise<RenderJob[]> {
    const rows = await withUserTx(this.ctx.pool, userId, (db) => renderRepository.listForProject(db, userId, projectId));
    return rows.map(toRenderJob);
  }

  async get(userId: string, id: string): Promise<RenderJob> {
    const row = await withUserTx(this.ctx.pool, userId, (db) => renderRepository.get(db, userId, id));
    if (!row) throw notFound('Render');
    return toRenderJob(row);
  }

  /** Queued jobs are cancelled immediately; processing jobs are flagged and stopped by the worker. */
  async cancel(userId: string, id: string): Promise<RenderJob> {
    const row = await withUserTx(this.ctx.pool, userId, (db) => renderRepository.get(db, userId, id));
    if (!row) throw notFound('Render');
    if (row.status !== 'queued' && row.status !== 'processing') return toRenderJob(row);
    await withServiceTx(this.ctx.pool, (db) =>
      db.query(
        `update public.render_jobs
            set cancel_requested = true,
                status = case when status = 'queued' then 'cancelled' else status end,
                error_category = case when status = 'queued' then 'cancelled' else error_category end,
                error_message = case when status = 'queued' then 'Cancelled' else error_message end,
                completed_at = case when status = 'queued' then now() else completed_at end
          where id = $1 and user_id = $2`,
        [id, userId],
      ),
    );
    return this.get(userId, id);
  }

  /** Ownership is checked before signing; the URL expires and names the file for download. */
  async downloadUrl(userId: string, id: string): Promise<{ url: string; expiresInSeconds: number }> {
    const row = await withUserTx(this.ctx.pool, userId, (db) => renderRepository.get(db, userId, id));
    if (!row) throw notFound('Render');
    if (row.status !== 'completed' || !row.output_path) throw new AppError(409, 'not_ready', 'This render has not finished');
    const ttl = this.ctx.env.SIGNED_URL_TTL_SECONDS;
    const url = await this.ctx.storage.createSignedUrl(row.output_path, {
      expiresInSeconds: ttl,
      downloadName: `clipforge-${row.id.slice(0, 8)}.mp4`,
    });
    return { url, expiresInSeconds: ttl };
  }

  /** Inline (non-download) URL for playing the finished video in the browser. */
  async playbackUrl(userId: string, id: string): Promise<{ url: string; expiresInSeconds: number }> {
    const row = await withUserTx(this.ctx.pool, userId, (db) => renderRepository.get(db, userId, id));
    if (!row) throw notFound('Render');
    if (row.status !== 'completed' || !row.output_path) throw new AppError(409, 'not_ready', 'This render has not finished');
    const ttl = this.ctx.env.SIGNED_URL_TTL_SECONDS;
    return { url: await this.ctx.storage.createSignedUrl(row.output_path, { expiresInSeconds: ttl }), expiresInSeconds: ttl };
  }
}
