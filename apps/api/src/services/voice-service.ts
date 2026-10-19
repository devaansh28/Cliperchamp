import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertWithinQuota, ProviderNotConfiguredError, storageKey, withUserTx, type ServerContext } from '@clipforge/server-core';
import { estimateSpeechDurationMs, QUEUE_NAMES, type MediaAsset } from '@clipforge/shared';
import { mediaRepository, toMediaAsset } from '../repositories/media-repository.js';
import { projectRepository } from '../repositories/project-repository.js';
import { badRequest, notFound } from '../utils/errors.js';
import { narrationText } from './script-service.js';

export class VoiceService {
  constructor(private readonly ctx: ServerContext) {}

  /** Short synchronous preview (≤200 chars) so users can audition a voice. */
  async preview(text: string, voiceId: string, speed: number): Promise<{ audio: Buffer; mimeType: string }> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cf-voice-'));
    try {
      const dest = path.join(dir, `preview.${this.ctx.tts.outputExt}`);
      const result = await this.ctx.tts.synthesize(text, voiceId, speed, dest);
      return { audio: await readFile(dest), mimeType: result.mimeType };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Queue full narration generation. Returns the pending asset; the worker fills in audio and duration. */
  async generate(userId: string, projectId: string, input: { text?: string; voiceId: string; speed: number }): Promise<MediaAsset> {
    if (!this.ctx.tts.configured) {
      throw new ProviderNotConfiguredError('tts', 'Set TTS_PROVIDER=espeak (free, local) or openai-compatible to generate voiceovers. You can upload your own narration instead.');
    }
    const id = randomUUID();
    const row = await withUserTx(this.ctx.pool, userId, async (db) => {
      const project = await projectRepository.getRow(db, userId, projectId);
      if (!project) throw notFound('Project');
      const text = (input.text ?? (project.script ? narrationText(project.script) : '')).trim();
      if (!text) throw badRequest('Add a script or narration text before generating a voiceover');
      if (text.length > 5000) throw badRequest('Narration text is too long (5000 characters max)');
      await assertWithinQuota(db, this.ctx.env, userId, 'voice_seconds', Math.ceil(estimateSpeechDurationMs(text) / 1000 / input.speed));
      const created = await mediaRepository.insert(db, {
        id,
        userId,
        projectId,
        kind: 'audio',
        source: 'tts',
        storagePath: storageKey(userId, 'voice', `${id}.${this.ctx.tts.outputExt}`),
        originalName: `voiceover-${input.voiceId}.${this.ctx.tts.outputExt}`,
        mimeType: this.ctx.tts.outputExt === 'mp3' ? 'audio/mpeg' : 'audio/wav',
        sizeBytes: 0,
        attribution: `Generated with ${this.ctx.tts.provider} (${input.voiceId})`,
      });
      return { created, text };
    });
    await this.ctx.queue.send(
      QUEUE_NAMES.generateVoice,
      { assetId: id, userId, text: row.text, voiceId: input.voiceId, speed: input.speed },
      { singletonKey: id },
    );
    return toMediaAsset(row.created);
  }
}
