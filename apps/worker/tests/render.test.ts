/**
 * Real rendering test: API creates a job from a saved project, the worker renders it with
 * Remotion + FFmpeg, and FFprobe verifies the MP4. Uses generated, license-free media.
 */
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorage, probeMedia, withServiceTx } from '@clipforge/server-core';
import { createTestContext, ensureFixtures, FIXTURES_DIR, resetDatabase } from '@clipforge/server-core/testing';
import { CaptionStyleSchema, QUEUE_NAMES, type Timeline } from '@clipforge/shared';
import { MediaService } from '../../api/src/services/media-service.js';
import { ProjectService } from '../../api/src/services/project-service.js';
import { RenderService } from '../../api/src/services/render-service.js';
import { createWorkerContext, type WorkerContext } from '../src/context.js';
import { handleCleanup } from '../src/jobs/cleanup.js';
import { handleProcessMedia } from '../src/jobs/process-media.js';
import { handleRenderVideo } from '../src/jobs/render-video.js';

let ctx: WorkerContext & { queue: ReturnType<typeof createTestContext>['queue'] };
let userA: string;
let userB: string;

async function createUser(email: string): Promise<string> {
  const r = await ctx.pool.query<{ id: string }>('insert into auth.users (email) values ($1) returning id', [email]);
  return r.rows[0]!.id;
}

async function upload(userId: string, projectId: string, fixture: string) {
  const media = new MediaService(ctx);
  const tmp = path.join(ctx.tempRoot, `${randomUUID()}-${fixture}`);
  copyFileSync(path.join(FIXTURES_DIR, fixture), tmp);
  const asset = await media.upload(userId, { path: tmp, size: 1, originalname: fixture }, projectId);
  for (const job of ctx.queue.take(QUEUE_NAMES.processMedia)) await handleProcessMedia(ctx, job, 0);
  return media.get(userId, asset.id);
}

beforeAll(async () => {
  ensureFixtures();
  resetDatabase();
  const base = createTestContext();
  ctx = { ...(await createWorkerContext(base)), queue: base.queue };
  userA = await createUser('render-a@example.com');
  userB = await createUser('render-b@example.com');
});

afterAll(async () => {
  await ctx?.assetServer.stop();
  await ctx?.pool.end();
});

describe('media processing', () => {
  it('probes uploads and normalizes non-web video to H.264 MP4', async () => {
    const project = await new ProjectService(ctx).create(userA, 'Media test');
    const mkv = await upload(userA, project.id, 'landscape.mkv');
    expect(mkv.status).toBe('ready');
    expect(mkv.mimeType).toBe('video/mp4');
    expect(mkv.durationMs).toBeGreaterThan(2900);
    expect(mkv.width).toBe(640);
    const wav = await upload(userA, project.id, 'narration.wav');
    expect(wav).toMatchObject({ status: 'ready', kind: 'audio' });
    expect(wav.durationMs).toBeGreaterThan(2900);
  });
});

describe('render pipeline', () => {
  let projectId: string;
  let jobId: string;

  it('renders a verified 1080x1920 H.264/AAC MP4 with captions, narration and music', async () => {
    const projects = new ProjectService(ctx);
    const project = await projects.create(userA, 'Render test');
    projectId = project.id;
    const bg = await upload(userA, projectId, 'background.mp4');
    const still = await upload(userA, projectId, 'still.png');
    const narration = await upload(userA, projectId, 'narration.wav');
    const music = await upload(userA, projectId, 'music.mp3');
    expect([bg.status, still.status, narration.status, music.status]).toEqual(['ready', 'ready', 'ready', 'ready']);

    const timeline: Timeline = {
      clips: [
        { id: randomUUID(), track: 'video', assetId: bg.id, order: 0, startMs: 0, trimStartMs: 500, durationMs: 2500, volume: 0, fit: 'cover', loop: false, transition: 'none', transitionMs: 300 },
        { id: randomUUID(), track: 'video', assetId: still.id, order: 1, startMs: 0, trimStartMs: 0, durationMs: 1500, volume: 1, fit: 'cover', loop: false, transition: 'fade', transitionMs: 300 },
        { id: randomUUID(), track: 'narration', assetId: narration.id, order: 0, startMs: 0, trimStartMs: 0, durationMs: 3000, volume: 1, fit: 'cover', loop: false, transition: 'none', transitionMs: 300 },
        { id: randomUUID(), track: 'music', assetId: music.id, order: 0, startMs: 0, trimStartMs: 0, durationMs: 4000, volume: 0.3, fit: 'cover', loop: false, transition: 'none', transitionMs: 300 },
      ],
      captions: [
        { id: randomUUID(), startMs: 0, endMs: 2000, text: 'ClipForge renders real video', timingSource: 'manual' },
        { id: randomUUID(), startMs: 2000, endMs: 4000, text: 'with captions and audio', timingSource: 'manual' },
      ],
      captionStyle: CaptionStyleSchema.parse({ highlightKeywords: ['real'] }),
      output: { width: 1080, height: 1920, fps: 30, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' },
      backgroundColor: '#0b0b10',
    };
    const saved = await projects.saveTimeline(userA, projectId, timeline, 0);
    expect(saved).toEqual({ revision: 1, durationMs: 4000 });

    const renders = new RenderService(ctx);
    const { job, created } = await renders.create(userA, projectId, { profile: 'full', idempotencyKey: 'render-test-key-1' });
    expect(created).toBe(true);
    expect(job.status).toBe('queued');
    jobId = job.id;

    // Duplicate requests reuse the active job instead of rendering twice.
    const again = await renders.create(userA, projectId, { profile: 'full', idempotencyKey: null });
    expect(again).toMatchObject({ created: false, job: { id: job.id } });

    const queued = ctx.queue.take(QUEUE_NAMES.renderVideo);
    expect(queued).toEqual([{ renderJobId: job.id }]);

    const progress: number[] = [];
    const poll = setInterval(() => {
      void ctx.pool.query<{ progress: number | null; status: string }>('select progress, status from public.render_jobs where id = $1', [job.id]).then((r) => {
        const p = r.rows[0]?.progress;
        if (p !== null && p !== undefined) progress.push(p);
      });
    }, 500);
    await handleRenderVideo(ctx, job.id);
    clearInterval(poll);

    const done = await renders.get(userA, job.id);
    expect(done.errorMessage).toBeNull();
    expect(done.status).toBe('completed');
    expect(done.attempt).toBe(1);
    expect(done.outputSizeBytes).toBeGreaterThan(10_000);
    expect(progress.length).toBeGreaterThan(0);

    // Independent FFprobe check of the stored object.
    const row = await ctx.pool.query<{ output_path: string }>('select output_path from public.render_jobs where id = $1', [job.id]);
    const file = (ctx.storage as LocalStorage).resolveKey(row.rows[0]!.output_path);
    const probe = await probeMedia(ctx.env.FFPROBE_PATH, file);
    expect(probe.video).toMatchObject({ codec_name: 'h264', width: 1080, height: 1920, pix_fmt: 'yuv420p' });
    expect(probe.video?.avg_frame_rate).toBe('30/1');
    expect(probe.audio?.codec_name).toBe('aac');
    expect(probe.durationMs).toBeGreaterThanOrEqual(3900);
    expect(probe.durationMs).toBeLessThanOrEqual(4150);

    // Temp files are gone.
    expect(existsSync(path.join(ctx.tempRoot, job.id))).toBe(false);

    // Usage recorded.
    const usage = await ctx.pool.query<{ kind: string; quantity: number }>(
      'select kind, quantity from public.usage_events where render_job_id = $1 order by kind',
      [job.id],
    );
    expect(usage.rows).toEqual([
      { kind: 'export', quantity: 1 },
      { kind: 'render_seconds', quantity: 4 },
    ]);
  });

  it('issues signed downloads to the owner only', async () => {
    const renders = new RenderService(ctx);
    const { url } = await renders.downloadUrl(userA, jobId);
    expect(url).toMatch(/\/files\/.+\.mp4\?exp=\d+&sig=.+&dl=clipforge-/u);
    await expect(renders.downloadUrl(userB, jobId)).rejects.toMatchObject({ status: 404 });
  });

  it('fails permanently with a useful message when media is broken', async () => {
    const projects = new ProjectService(ctx);
    const project = await projects.create(userA, 'Broken media');
    const bg = await upload(userA, project.id, 'background.mp4');
    await projects.saveTimeline(
      userA,
      project.id,
      {
        clips: [{ id: randomUUID(), track: 'video', assetId: bg.id, order: 0, startMs: 0, trimStartMs: 0, durationMs: 1000, volume: 1, fit: 'cover', loop: false, transition: 'none', transitionMs: 300 }],
        captions: [],
        captionStyle: CaptionStyleSchema.parse({}),
        output: { width: 1080, height: 1920, fps: 30, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' },
        backgroundColor: '#000000',
      },
      0,
    );
    const { job } = await new RenderService(ctx).create(userA, project.id, { profile: 'preview', idempotencyKey: null });
    ctx.queue.take(QUEUE_NAMES.renderVideo);
    // Corrupt the stored object after the job was queued.
    const storagePath = (await ctx.pool.query<{ storage_path: string }>('select storage_path from public.media_assets where id = $1', [bg.id])).rows[0]!.storage_path;
    const { writeFileSync } = await import('node:fs');
    writeFileSync((ctx.storage as LocalStorage).resolveKey(storagePath), 'garbage');

    await handleRenderVideo(ctx, job.id); // must not throw: permanent errors are not retried
    const failed = await new RenderService(ctx).get(userA, job.id);
    expect(failed.status).toBe('failed');
    expect(failed.errorCategory).toBe('media');
    expect(failed.errorMessage).toMatch(/could not be read/u);
    const detail = await ctx.pool.query<{ error_detail: string }>('select error_detail from public.render_jobs where id = $1', [job.id]);
    expect(detail.rows[0]!.error_detail).toMatch(/ProbeError/u);
  });

  it('marks cancelled queued jobs without rendering', async () => {
    const projects = new ProjectService(ctx);
    const project = await projects.create(userA, 'Cancel me');
    await projects.saveTimeline(
      userA,
      project.id,
      {
        clips: [],
        captions: [{ id: randomUUID(), startMs: 0, endMs: 1000, text: 'hello', timingSource: 'manual' }],
        captionStyle: CaptionStyleSchema.parse({}),
        output: { width: 1080, height: 1920, fps: 30, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' },
        backgroundColor: '#000000',
      },
      0,
    );
    const renders = new RenderService(ctx);
    const { job } = await renders.create(userA, project.id, { profile: 'preview', idempotencyKey: null });
    const cancelled = await renders.cancel(userA, job.id);
    expect(cancelled.status).toBe('cancelled');
    await handleRenderVideo(ctx, job.id);
    expect((await renders.get(userA, job.id)).status).toBe('cancelled');
  });

  it('cleanup fails abandoned jobs and removes stale temp directories', async () => {
    await withServiceTx(ctx.pool, async (db) => {
      await db.query(
        `insert into public.render_jobs (project_id, user_id, status, input_snapshot, started_at, heartbeat_at)
         values ($1, $2, 'processing', '{}'::jsonb, now() - interval '1 hour', now() - interval '1 hour')`,
        [projectId, userA],
      );
    });
    const { mkdirSync, utimesSync } = await import('node:fs');
    const stale = path.join(ctx.tempRoot, 'stale-job');
    mkdirSync(stale, { recursive: true });
    const old = new Date(Date.now() - 4 * 60 * 60_000);
    utimesSync(stale, old, old);
    const stats = await handleCleanup(ctx);
    expect(stats.staleRenders).toBe(1);
    expect(stats.tempDirsRemoved).toBeGreaterThanOrEqual(1);
    expect(readdirSync(ctx.tempRoot)).not.toContain('stale-job');
  });
});
