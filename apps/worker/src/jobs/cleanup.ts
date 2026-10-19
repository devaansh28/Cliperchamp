import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { WorkerContext } from '../context.js';

const STALE_HEARTBEAT_MINUTES = 15;
const TEMP_MAX_AGE_MS = 3 * 60 * 60_000;

/** Periodic housekeeping: abandoned jobs, expired outputs, stuck media and orphaned temp files. */
export async function handleCleanup(ctx: WorkerContext): Promise<Record<string, number>> {
  const stats: Record<string, number> = {};

  // Jobs whose worker stopped reporting progress (crash, OOM, killed container).
  const stale = await ctx.pool.query(
    `update public.render_jobs set status = 'failed', error_category = 'timeout',
       error_message = 'Rendering stopped unexpectedly. Please try again.', completed_at = now()
     where status = 'processing' and coalesce(heartbeat_at, started_at) < now() - ($1 || ' minutes')::interval
     returning id`,
    [String(STALE_HEARTBEAT_MINUTES)],
  );
  stats.staleRenders = stale.rowCount ?? 0;

  // Queued jobs never picked up (queue lost them).
  const orphaned = await ctx.pool.query(
    `update public.render_jobs set status = 'failed', error_category = 'internal',
       error_message = 'The render was not started. Please try again.', completed_at = now()
     where status = 'queued' and updated_at < now() - interval '6 hours' returning id`,
  );
  stats.orphanedRenders = orphaned.rowCount ?? 0;

  // Retention: delete old render outputs, keep the job row as history.
  const expired = await ctx.pool.query<{ id: string; output_path: string; thumbnail_path: string | null }>(
    `select id, output_path, thumbnail_path from public.render_jobs
      where status = 'completed' and output_path is not null and completed_at < now() - ($1 || ' days')::interval
      limit 200`,
    [String(ctx.env.RENDER_RETENTION_DAYS)],
  );
  for (const row of expired.rows) {
    try {
      await ctx.storage.remove([row.output_path]);
      await ctx.pool.query(
        `update public.render_jobs set output_path = null, error_message = 'Download expired after the retention period.' where id = $1`,
        [row.id],
      );
    } catch (err) {
      ctx.log.warn({ err, renderJobId: row.id }, 'retention delete failed');
    }
  }
  stats.expiredOutputs = expired.rowCount ?? 0;

  const stuckMedia = await ctx.pool.query(
    `update public.media_assets set status = 'failed', error_message = 'Processing did not finish. Please upload again.'
      where status = 'pending' and created_at < now() - interval '2 hours' returning id`,
  );
  stats.stuckMedia = stuckMedia.rowCount ?? 0;

  // Temp directories left behind by crashed jobs.
  let removed = 0;
  try {
    for (const name of await readdir(ctx.tempRoot)) {
      const full = path.join(ctx.tempRoot, name);
      const s = await stat(full).catch(() => null);
      if (s && Date.now() - s.mtimeMs > TEMP_MAX_AGE_MS) {
        await rm(full, { recursive: true, force: true });
        removed += 1;
      }
    }
  } catch {
    /* temp root may not exist yet */
  }
  stats.tempDirsRemoved = removed;
  ctx.log.info(stats, 'cleanup finished');
  return stats;
}
