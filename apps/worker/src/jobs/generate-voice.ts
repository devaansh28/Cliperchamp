import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { probeMedia, recordUsage, withServiceTx, type GenerateVoiceJob } from '@clipforge/server-core';
import type { WorkerContext } from '../context.js';
import { classifyError } from '../utils/job-errors.js';

/** Synthesize narration, measure its real duration with ffprobe, store it and mark the asset ready. */
export async function handleGenerateVoice(ctx: WorkerContext, job: GenerateVoiceJob, retryCount: number): Promise<void> {
  const r = await ctx.pool.query<{ storage_path: string; status: string; project_id: string | null }>(
    `select storage_path, status, project_id from public.media_assets where id = $1 and user_id = $2 and source = 'tts'`,
    [job.assetId, job.userId],
  );
  const asset = r.rows[0];
  if (!asset || asset.status !== 'pending') return;

  const dir = path.join(ctx.tempRoot, `voice-${job.assetId}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const out = path.join(dir, `voice.${ctx.tts.outputExt}`);
    await ctx.tts.synthesize(job.text, job.voiceId, job.speed, out);
    const probe = await probeMedia(ctx.env.FFPROBE_PATH, out);
    if (!probe.audio || !probe.durationMs) throw new Error('Synthesized audio has no duration');
    const size = (await stat(out)).size;
    await ctx.storage.putFile(asset.storage_path, out, ctx.tts.outputExt === 'mp3' ? 'audio/mpeg' : 'audio/wav');
    await withServiceTx(ctx.pool, async (db) => {
      await db.query(
        `update public.media_assets set status = 'ready', size_bytes = $2, duration_ms = $3, error_message = null where id = $1`,
        [job.assetId, size, probe.durationMs],
      );
      await recordUsage(db, { userId: job.userId, kind: 'voice_seconds', quantity: Math.ceil(probe.durationMs! / 1000), projectId: asset.project_id });
    });
    ctx.log.info({ assetId: job.assetId, durationMs: probe.durationMs }, 'voiceover ready');
  } catch (err) {
    const c = classifyError(err);
    const retry = c.retryable && retryCount < 2;
    ctx.log.warn({ assetId: job.assetId, detail: c.detail, retry }, 'voiceover failed');
    if (!retry) {
      await ctx.pool.query(`update public.media_assets set status = 'failed', error_message = $2 where id = $1`, [
        job.assetId,
        c.category === 'render' ? 'Voice generation failed. Please try again.' : c.userMessage,
      ]);
      return;
    }
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
