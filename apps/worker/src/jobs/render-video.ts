import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  recordUsage,
  RenderSnapshotSchema,
  storageKey,
  withServiceTx,
  type RenderSnapshot,
} from '@clipforge/server-core';
import { timelineDurationMs } from '@clipforge/shared';
import type { WorkerContext } from '../context.js';
import { buildCompositionInput, type StagedAsset } from '../render/composition-input.js';
import { inspectSource, validateOutput } from '../render/media-probe.js';
import { classifyError, PermanentJobError } from '../utils/job-errors.js';

interface JobRow {
  id: string;
  project_id: string;
  user_id: string;
  status: string;
  attempt: number;
  max_attempts: number;
  cancel_requested: boolean;
  input_snapshot: unknown;
}

const EXT_BY_MIME: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
};

/** Atomically claim a job; returns null if it is finished, cancelled or out of attempts. */
async function claim(ctx: WorkerContext, renderJobId: string): Promise<JobRow | null> {
  return withServiceTx(ctx.pool, async (db) => {
    const r = await db.query<JobRow>(
      `select id, project_id, user_id, status, attempt, max_attempts, cancel_requested, input_snapshot
         from public.render_jobs where id = $1 for update`,
      [renderJobId],
    );
    const job = r.rows[0];
    if (!job || (job.status !== 'queued' && job.status !== 'processing')) return null;
    if (job.cancel_requested) {
      await db.query(
        `update public.render_jobs set status = 'cancelled', error_category = 'cancelled', error_message = 'Cancelled', completed_at = now() where id = $1`,
        [job.id],
      );
      return null;
    }
    if (job.attempt >= job.max_attempts) {
      await db.query(
        `update public.render_jobs set status = 'failed', error_category = coalesce(error_category, 'internal'),
           error_message = coalesce(error_message, 'Rendering failed after several attempts.'), completed_at = now() where id = $1`,
        [job.id],
      );
      return null;
    }
    await db.query(
      `update public.render_jobs set status = 'processing', attempt = attempt + 1, progress = null, started_at = now(),
         heartbeat_at = now(), error_category = null, error_message = null, error_detail = null where id = $1`,
      [job.id],
    );
    return { ...job, attempt: job.attempt + 1 };
  });
}

/** Re-check ownership: every asset in the snapshot must still belong to the job's user. */
async function verifyAssets(ctx: WorkerContext, job: JobRow, snapshot: RenderSnapshot): Promise<void> {
  const ids = snapshot.assets.map((a) => a.id);
  if (ids.length === 0) return;
  const r = await ctx.pool.query<{ id: string; storage_path: string }>(
    `select id, storage_path from public.media_assets where user_id = $1 and id = any($2::uuid[]) and status = 'ready'`,
    [job.user_id, ids],
  );
  const owned = new Map(r.rows.map((row) => [row.id, row.storage_path]));
  for (const a of snapshot.assets) {
    if (owned.get(a.id) !== a.storagePath) throw new PermanentJobError('validation', 'Some media in this project is no longer available.');
  }
}

export async function handleRenderVideo(ctx: WorkerContext, renderJobId: string): Promise<void> {
  const job = await claim(ctx, renderJobId);
  if (!job) return;
  const log = ctx.log.child({ renderJobId: job.id, attempt: job.attempt });
  const workDir = path.join(ctx.tempRoot, job.id);
  let registration: { token: string } | null = null;
  const started = Date.now();
  log.info('render started');

  try {
    const parsed = RenderSnapshotSchema.safeParse(job.input_snapshot);
    if (!parsed.success) throw new PermanentJobError('validation', 'The project data could not be read.', parsed.error.message);
    const snapshot = parsed.data;
    await verifyAssets(ctx, job, snapshot);

    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true, mode: 0o700 });

    // Stage, inspect and (if needed) normalize each source.
    const staged: StagedAsset[] = [];
    for (const asset of snapshot.assets) {
      const ext = EXT_BY_MIME[asset.mimeType] ?? 'bin';
      const local = path.join(workDir, `${asset.id}.${ext}`);
      await ctx.storage.getToFile(asset.storagePath, local);
      const probe = await inspectSource(ctx.env.FFPROBE_PATH, local, asset.kind, {
        maxDurationMs: 60 * 60_000,
        maxDimension: 4096,
      });
      let filename = path.basename(local);
      if (asset.kind === 'video' && ctx.ffmpeg.needsVideoTranscode(probe)) {
        filename = `${asset.id}.norm.mp4`;
        await ctx.ffmpeg.toWebVideo(local, path.join(workDir, filename));
      } else if (asset.kind === 'audio' && ctx.ffmpeg.needsAudioTranscode(probe)) {
        filename = `${asset.id}.norm.m4a`;
        await ctx.ffmpeg.toAac(local, path.join(workDir, filename));
      }
      staged.push({
        id: asset.id,
        kind: asset.kind,
        filename,
        durationMs: probe.durationMs ?? asset.durationMs,
        width: probe.video?.width ?? asset.width,
        height: probe.video?.height ?? asset.height,
      });
    }

    registration = ctx.assetServer.register(workDir);
    const reg = registration as ReturnType<WorkerContext['assetServer']['register']>;
    const inputProps = buildCompositionInput(snapshot, staged, reg.urlFor);
    const outFile = path.join(workDir, 'output.mp4');

    const { durationInFrames, fps } = await ctx.renderer.render({
      inputProps,
      outputLocation: outFile,
      timeoutMs: ctx.env.RENDER_TIMEOUT_SECONDS * 1000,
      onProgress: async (progress) => {
        const r = await ctx.pool.query<{ cancel_requested: boolean }>(
          `update public.render_jobs set progress = $2, heartbeat_at = now() where id = $1 returning cancel_requested`,
          [job.id, Math.min(0.99, Math.max(0, progress))],
        );
        return r.rows[0]?.cancel_requested === true;
      },
    });

    const expectedMs = Math.round((durationInFrames / fps) * 1000);
    const hasAudio = snapshot.timeline.clips.some(
      (c) => (c.track === 'narration' || c.track === 'music') && c.volume > 0,
    );
    const check = await validateOutput(ctx.env.FFPROBE_PATH, outFile, {
      profile: snapshot.output,
      durationMs: expectedMs,
      expectAudio: hasAudio,
      maxSizeBytes: ctx.env.RENDER_MAX_FILE_SIZE_MB * 1024 * 1024,
    });
    if (!check.ok) throw new PermanentJobError('render', 'The rendered file failed verification.', check.problems.join('; '));

    const thumbFile = path.join(workDir, 'thumb.jpg');
    await ctx.ffmpeg.thumbnail(outFile, thumbFile, Math.min(1, expectedMs / 2000));

    const outputKey = storageKey(job.user_id, 'renders', `${job.project_id}/${job.id}.mp4`);
    const thumbKey = storageKey(job.user_id, 'thumbnails', `${job.project_id}/${job.id}.jpg`);
    await ctx.storage.putFile(outputKey, outFile, 'video/mp4');
    await ctx.storage.putFile(thumbKey, thumbFile, 'image/jpeg');

    const renderSeconds = Math.ceil(timelineDurationMs(snapshot.timeline) / 1000);
    await withServiceTx(ctx.pool, async (db) => {
      await db.query(
        `update public.render_jobs set status = 'completed', progress = 1, output_path = $2, output_size_bytes = $3,
           output_duration_ms = $4, thumbnail_path = $5, completed_at = now(), heartbeat_at = now() where id = $1`,
        [job.id, outputKey, check.sizeBytes, check.durationMs, thumbKey],
      );
      await db.query('update public.projects set thumbnail_path = $2 where id = $1 and user_id = $3', [job.project_id, thumbKey, job.user_id]);
      await recordUsage(db, { userId: job.user_id, kind: 'render_seconds', quantity: renderSeconds, projectId: job.project_id, renderJobId: job.id });
      await recordUsage(db, { userId: job.user_id, kind: 'export', quantity: 1, projectId: job.project_id, renderJobId: job.id });
    });
    log.info({ ms: Date.now() - started, sizeBytes: check.sizeBytes, durationMs: check.durationMs }, 'render completed');
  } catch (err) {
    const c = classifyError(err);
    const retry = c.retryable && job.attempt < job.max_attempts;
    log.error({ category: c.category, retry, detail: c.detail, ms: Date.now() - started }, 'render failed');
    await ctx.pool.query(
      `update public.render_jobs set status = $2, error_category = $3, error_message = $4, error_detail = $5,
         completed_at = case when $2 = 'queued' then null else now() end, progress = null
       where id = $1`,
      [job.id, retry ? 'queued' : c.category === 'cancelled' ? 'cancelled' : 'failed', c.category, c.userMessage, c.detail],
    );
    // Throwing hands the job back to the queue for a delayed retry; permanent failures end here.
    if (retry) throw err;
  } finally {
    if (registration) ctx.assetServer.unregister(registration.token);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
