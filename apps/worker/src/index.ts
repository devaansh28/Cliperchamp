import { mkdir } from 'node:fs/promises';
import { ConfigError, createBaseContext, createLogger, loadEnv, PgBossQueue } from '@clipforge/server-core';
import { QUEUE_NAMES } from '@clipforge/shared';
import { createWorkerContext } from './context.js';
import { handleCleanup } from './jobs/cleanup.js';
import { handleGenerateVoice } from './jobs/generate-voice.js';
import { handleProcessMedia } from './jobs/process-media.js';
import { handleRenderVideo } from './jobs/render-video.js';

async function main() {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }
  const log = createLogger('worker', env.LOG_LEVEL);
  const queue = await PgBossQueue.start(env.SUPABASE_DB_URL, (err) => log.error({ err }, 'queue error'));
  const ctx = await createWorkerContext(createBaseContext(env, log, queue));
  await mkdir(ctx.tempRoot, { recursive: true, mode: 0o700 });

  // Bundle up front so the first render does not pay for it, and so a broken bundle fails loudly at startup.
  await ctx.renderer.bundle();

  // Queue recovery: anything left "processing" by a crashed worker is retried or failed by the cleanup job.
  await handleCleanup(ctx).catch((err: unknown) => log.error({ err }, 'startup cleanup failed'));

  await queue.work(QUEUE_NAMES.renderVideo, { concurrency: env.RENDER_CONCURRENCY }, (data) => handleRenderVideo(ctx, data.renderJobId));
  await queue.work(QUEUE_NAMES.generateVoice, { concurrency: 2 }, (data, meta) => handleGenerateVoice(ctx, data, meta.retryCount));
  await queue.work(QUEUE_NAMES.processMedia, { concurrency: 2 }, (data, meta) => handleProcessMedia(ctx, data, meta.retryCount));
  await queue.work(QUEUE_NAMES.cleanup, { concurrency: 1 }, async () => {
    await handleCleanup(ctx);
  });
  await queue.schedule(QUEUE_NAMES.cleanup, '*/15 * * * *');
  log.info({ renderConcurrency: env.RENDER_CONCURRENCY, tts: ctx.tts.provider }, 'worker ready');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'worker shutting down; finishing active jobs');
    const force = setTimeout(() => process.exit(1), 60_000);
    force.unref();
    await queue.stop().catch(() => undefined);
    await ctx.assetServer.stop().catch(() => undefined);
    await ctx.pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
