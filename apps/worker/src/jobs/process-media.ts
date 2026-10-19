import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sniffMedia, type ProcessMediaJob } from '@clipforge/server-core';
import type { WorkerContext } from '../context.js';
import { inspectSource } from '../render/media-probe.js';
import { classifyError, PermanentJobError } from '../utils/job-errors.js';

interface AssetRow {
  storage_path: string;
  status: string;
  kind: 'video' | 'image' | 'audio';
  mime_type: string;
}

/** Download a remote stock file, only from the provider's allowlisted HTTPS hosts and within the size limit. */
async function downloadRemote(ctx: WorkerContext, externalId: string, dest: string): Promise<void> {
  const resolved = await ctx.media.resolveDownload(externalId);
  let url: URL;
  try {
    url = new URL(resolved.url);
  } catch {
    throw new PermanentJobError('validation', 'Invalid stock media URL.');
  }
  if (url.protocol !== 'https:' || !ctx.media.allowedDownloadHosts.includes(url.hostname)) {
    throw new PermanentJobError('validation', 'Stock media came from an unapproved host.');
  }
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5 * 60_000) });
  const finalHost = new URL(res.url).hostname;
  if (!ctx.media.allowedDownloadHosts.includes(finalHost)) throw new PermanentJobError('validation', 'Stock media redirected to an unapproved host.');
  if (!res.ok || !res.body) throw new Error(`Stock download HTTP ${res.status}`);
  const max = ctx.env.UPLOAD_MAX_FILE_SIZE_MB * 1024 * 1024;
  let seen = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      cb(seen > max ? new PermanentJobError('validation', 'Stock file is larger than the upload limit.') : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), limiter, createWriteStream(dest, { mode: 0o600 }));
}

/** Inspect an uploaded or imported file with FFprobe, normalize it for browsers if needed, and mark it ready. */
export async function handleProcessMedia(ctx: WorkerContext, job: ProcessMediaJob, retryCount: number): Promise<void> {
  const r = await ctx.pool.query<AssetRow>(
    `select storage_path, status, kind, mime_type from public.media_assets where id = $1 and user_id = $2`,
    [job.assetId, job.userId],
  );
  const asset = r.rows[0];
  if (!asset || asset.status !== 'pending') return;

  const dir = path.join(ctx.tempRoot, `media-${job.assetId}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const original = path.join(dir, `source${path.extname(asset.storage_path)}`);
    if (job.remote) {
      await downloadRemote(ctx, job.remote.externalId, original);
      const sniffed = await sniffMedia(original);
      if (!sniffed || sniffed.kind !== asset.kind) throw new PermanentJobError('validation', 'Stock file type did not match.');
    } else {
      await ctx.storage.getToFile(asset.storage_path, original);
    }

    const probe = await inspectSource(ctx.env.FFPROBE_PATH, original, asset.kind, {
      maxDurationMs: ctx.env.RENDER_MAX_DURATION_SECONDS * 1000 * 10,
      maxDimension: 4096,
    });

    let finalPath = original;
    let mime = asset.mime_type;
    let storagePath = asset.storage_path;
    let finalProbe = probe;
    if (asset.kind === 'video' && ctx.ffmpeg.needsVideoTranscode(probe)) {
      finalPath = path.join(dir, 'normalized.mp4');
      await ctx.ffmpeg.toWebVideo(original, finalPath);
      mime = 'video/mp4';
      storagePath = asset.storage_path.replace(/\.[a-z0-9]+$/u, '.mp4');
      finalProbe = await inspectSource(ctx.env.FFPROBE_PATH, finalPath, 'video', { maxDurationMs: Number.MAX_SAFE_INTEGER, maxDimension: 4096 });
    } else if (asset.kind === 'audio' && ctx.ffmpeg.needsAudioTranscode(probe)) {
      finalPath = path.join(dir, 'normalized.m4a');
      await ctx.ffmpeg.toAac(original, finalPath);
      mime = 'audio/mp4';
      storagePath = asset.storage_path.replace(/\.[a-z0-9]+$/u, '.m4a');
      finalProbe = await inspectSource(ctx.env.FFPROBE_PATH, finalPath, 'audio', { maxDurationMs: Number.MAX_SAFE_INTEGER, maxDimension: 4096 });
    }

    if (job.remote || storagePath !== asset.storage_path) await ctx.storage.putFile(storagePath, finalPath, mime);
    if (storagePath !== asset.storage_path && !job.remote) await ctx.storage.remove([asset.storage_path]).catch(() => undefined);

    const size = (await stat(finalPath)).size;
    await ctx.pool.query(
      `update public.media_assets set status = 'ready', storage_path = $2, mime_type = $3, size_bytes = $4,
         duration_ms = $5, width = $6, height = $7, error_message = null where id = $1`,
      [
        job.assetId,
        storagePath,
        mime,
        size,
        asset.kind === 'image' ? null : finalProbe.durationMs,
        finalProbe.video?.width ?? null,
        finalProbe.video?.height ?? null,
      ],
    );
    ctx.log.info({ assetId: job.assetId, kind: asset.kind, durationMs: finalProbe.durationMs }, 'media ready');
  } catch (err) {
    const c = classifyError(err);
    const retry = c.retryable && retryCount < 2;
    ctx.log.warn({ assetId: job.assetId, detail: c.detail, retry }, 'media processing failed');
    if (!retry) {
      await ctx.pool.query(`update public.media_assets set status = 'failed', error_message = $2 where id = $1`, [
        job.assetId,
        c.category === 'render' ? 'This file could not be processed.' : c.userMessage,
      ]);
      return;
    }
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
