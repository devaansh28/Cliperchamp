import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import {
  assertWithinQuota,
  isAllowedMime,
  sniffMedia,
  storageKey,
  withUserTx,
  type ServerContext,
} from '@clipforge/server-core';
import { QUEUE_NAMES, type MediaAsset } from '@clipforge/shared';
import { mediaRepository, toMediaAsset, type MediaRow } from '../repositories/media-repository.js';
import { projectRepository } from '../repositories/project-repository.js';
import { AppError, conflict, notFound } from '../utils/errors.js';

export type MediaAssetWithUrl = MediaAsset & { url: string | null };

/** Strip paths and unusual characters from client-supplied filenames. */
export function safeFilename(name: string | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/u).pop() ?? '';
  const cleaned = base.replace(/[^\p{L}\p{N}._ -]/gu, '_').trim().slice(0, 120);
  return cleaned || null;
}

export class MediaService {
  constructor(private readonly ctx: ServerContext) {}

  async withUrl(row: MediaRow): Promise<MediaAssetWithUrl> {
    const url =
      row.status === 'ready'
        ? await this.ctx.storage.createSignedUrl(row.storage_path, { expiresInSeconds: this.ctx.env.SIGNED_URL_TTL_SECONDS })
        : null;
    return { ...toMediaAsset(row), url };
  }

  /**
   * Accept an uploaded temp file: verify real type from file bytes, enforce quota,
   * store it privately and queue FFprobe inspection. The temp file is always removed.
   */
  async upload(userId: string, file: { path: string; size: number; originalname?: string }, projectId: string | null): Promise<MediaAsset> {
    try {
      const sniffed = await sniffMedia(file.path);
      if (!sniffed || !isAllowedMime(sniffed.mime)) {
        throw new AppError(415, 'unsupported_media', 'Unsupported file type. Upload MP4, MOV, WebM, PNG, JPEG, WebP, MP3, WAV, M4A or OGG.');
      }
      const id = randomUUID();
      const key = storageKey(userId, 'uploads', `${id}.${sniffed.ext}`);
      await withUserTx(this.ctx.pool, userId, async (db) => {
        if (projectId && !(await projectRepository.getRow(db, userId, projectId))) throw notFound('Project');
        await assertWithinQuota(db, this.ctx.env, userId, 'storage_bytes', file.size);
      });
      await this.ctx.storage.putFile(key, file.path, sniffed.mime);
      const row = await withUserTx(this.ctx.pool, userId, (db) =>
        mediaRepository.insert(db, {
          id,
          userId,
          projectId,
          kind: sniffed.kind,
          source: 'upload',
          storagePath: key,
          originalName: safeFilename(file.originalname),
          mimeType: sniffed.mime,
          sizeBytes: file.size,
        }),
      );
      await this.ctx.queue.send(QUEUE_NAMES.processMedia, { assetId: id, userId }, { singletonKey: id });
      return toMediaAsset(row);
    } finally {
      await rm(file.path, { force: true });
    }
  }

  async list(userId: string, projectId: string | null): Promise<MediaAssetWithUrl[]> {
    const rows = await withUserTx(this.ctx.pool, userId, (db) =>
      projectId ? mediaRepository.listForProject(db, userId, projectId) : mediaRepository.listAll(db, userId),
    );
    return Promise.all(rows.map((r) => this.withUrl(r)));
  }

  async get(userId: string, id: string): Promise<MediaAssetWithUrl> {
    const row = await withUserTx(this.ctx.pool, userId, (db) => mediaRepository.get(db, userId, id));
    if (!row) throw notFound('Media');
    return this.withUrl(row);
  }

  async delete(userId: string, id: string): Promise<void> {
    const path = await withUserTx(this.ctx.pool, userId, async (db) => {
      const row = await mediaRepository.get(db, userId, id);
      if (!row) throw notFound('Media');
      if (await mediaRepository.isUsed(db, id)) throw conflict('This media is used in a project timeline. Remove it from the timeline first.');
      await mediaRepository.delete(db, userId, id);
      return row.storage_path;
    });
    await this.ctx.storage.remove([path]).catch((err: unknown) => this.ctx.log.warn({ err }, 'media object delete failed'));
  }

  /** Register a stock asset; the worker downloads it from the provider's allowlisted hosts only. */
  async importStock(userId: string, projectId: string | null, externalId: string): Promise<MediaAsset> {
    const resolved = await this.ctx.media.resolveDownload(externalId);
    const id = randomUUID();
    const ext = resolved.kind === 'video' ? 'mp4' : 'jpg';
    const row = await withUserTx(this.ctx.pool, userId, async (db) => {
      if (projectId && !(await projectRepository.getRow(db, userId, projectId))) throw notFound('Project');
      return mediaRepository.insert(db, {
        id,
        userId,
        projectId,
        kind: resolved.kind,
        source: 'stock',
        storagePath: storageKey(userId, 'uploads', `${id}.${ext}`),
        originalName: `pexels-${externalId}.${ext}`,
        mimeType: resolved.mimeType,
        sizeBytes: 0,
        attribution: resolved.attribution,
        license: resolved.license,
        sourceUrl: resolved.pageUrl,
      });
    });
    await this.ctx.queue.send(QUEUE_NAMES.processMedia, { assetId: id, userId, remote: { provider: 'pexels', externalId } }, { singletonKey: id });
    return toMediaAsset(row);
  }
}
