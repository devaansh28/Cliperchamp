import type { PoolClient } from '@clipforge/server-core';
import type { MediaAsset, MediaKind } from '@clipforge/shared';

export interface MediaRow {
  id: string;
  user_id: string;
  project_id: string | null;
  kind: MediaKind;
  source: MediaAsset['source'];
  status: MediaAsset['status'];
  storage_path: string;
  original_name: string | null;
  mime_type: string;
  size_bytes: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  attribution: string | null;
  license: string | null;
  source_url: string | null;
  error_message: string | null;
  created_at: Date;
}

export function toMediaAsset(r: MediaRow): MediaAsset {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    source: r.source,
    status: r.status,
    originalName: r.original_name,
    mimeType: r.mime_type,
    sizeBytes: Number(r.size_bytes),
    durationMs: r.duration_ms,
    width: r.width,
    height: r.height,
    attribution: r.attribution,
    license: r.license,
    errorMessage: r.error_message,
    createdAt: r.created_at.toISOString(),
  };
}

export const mediaRepository = {
  async insert(
    db: PoolClient,
    a: {
      id: string;
      userId: string;
      projectId: string | null;
      kind: MediaKind;
      source: MediaAsset['source'];
      storagePath: string;
      originalName: string | null;
      mimeType: string;
      sizeBytes: number;
      attribution?: string | null;
      license?: string | null;
      sourceUrl?: string | null;
    },
  ): Promise<MediaRow> {
    const r = await db.query<MediaRow>(
      `insert into public.media_assets
         (id, user_id, project_id, kind, source, status, storage_path, original_name, mime_type, size_bytes, attribution, license, source_url)
       values ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11, $12) returning *`,
      [a.id, a.userId, a.projectId, a.kind, a.source, a.storagePath, a.originalName, a.mimeType, a.sizeBytes, a.attribution ?? null, a.license ?? null, a.sourceUrl ?? null],
    );
    return r.rows[0]!;
  },

  async get(db: PoolClient, userId: string, id: string): Promise<MediaRow | null> {
    const r = await db.query<MediaRow>('select * from public.media_assets where id = $1 and user_id = $2', [id, userId]);
    return r.rows[0] ?? null;
  },

  async getMany(db: PoolClient, userId: string, ids: string[]): Promise<MediaRow[]> {
    if (ids.length === 0) return [];
    const r = await db.query<MediaRow>('select * from public.media_assets where user_id = $1 and id = any($2::uuid[])', [userId, ids]);
    return r.rows;
  },

  /** Assets attached to a project plus any asset its timeline references. */
  async listForProject(db: PoolClient, userId: string, projectId: string): Promise<MediaRow[]> {
    const r = await db.query<MediaRow>(
      `select * from public.media_assets m
        where m.user_id = $1
          and (m.project_id = $2 or m.id in (select asset_id from public.timeline_clips where project_id = $2))
        order by m.created_at desc`,
      [userId, projectId],
    );
    return r.rows;
  },

  async listAll(db: PoolClient, userId: string, limit = 200): Promise<MediaRow[]> {
    const r = await db.query<MediaRow>('select * from public.media_assets where user_id = $1 order by created_at desc limit $2', [userId, limit]);
    return r.rows;
  },

  async isUsed(db: PoolClient, id: string): Promise<boolean> {
    const r = await db.query('select 1 from public.timeline_clips where asset_id = $1 limit 1', [id]);
    return (r.rowCount ?? 0) > 0;
  },

  async delete(db: PoolClient, userId: string, id: string): Promise<void> {
    await db.query('delete from public.media_assets where id = $1 and user_id = $2', [id, userId]);
  },
};
