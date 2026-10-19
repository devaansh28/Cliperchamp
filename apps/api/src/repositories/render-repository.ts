import type { PoolClient } from '@clipforge/server-core';
import type { RenderErrorCategory, RenderJob, RenderJobStatus } from '@clipforge/shared';

export interface RenderRow {
  id: string;
  project_id: string;
  user_id: string;
  status: RenderJobStatus;
  profile: 'full' | 'preview';
  attempt: number;
  progress: number | null;
  idempotency_key: string | null;
  output_path: string | null;
  output_size_bytes: number | null;
  output_duration_ms: number | null;
  thumbnail_path: string | null;
  error_category: RenderErrorCategory | null;
  error_message: string | null;
  cancel_requested: boolean;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

export function toRenderJob(r: RenderRow): RenderJob {
  return {
    id: r.id,
    projectId: r.project_id,
    status: r.status,
    profile: r.profile,
    attempt: r.attempt,
    progress: r.progress,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    completedAt: r.completed_at?.toISOString() ?? null,
    outputSizeBytes: r.output_size_bytes,
    outputDurationMs: r.output_duration_ms,
    errorCategory: r.error_category,
    errorMessage: r.error_message,
  };
}

const COLUMNS = `id, project_id, user_id, status, profile, attempt, progress, idempotency_key, output_path, output_size_bytes,
  output_duration_ms, thumbnail_path, error_category, error_message, cancel_requested, created_at, started_at, completed_at`;

export const renderRepository = {
  async findActive(db: PoolClient, projectId: string): Promise<RenderRow | null> {
    const r = await db.query<RenderRow>(
      `select ${COLUMNS} from public.render_jobs where project_id = $1 and status in ('queued', 'processing') limit 1`,
      [projectId],
    );
    return r.rows[0] ?? null;
  },

  async findByIdempotencyKey(db: PoolClient, userId: string, key: string): Promise<RenderRow | null> {
    const r = await db.query<RenderRow>(`select ${COLUMNS} from public.render_jobs where user_id = $1 and idempotency_key = $2`, [userId, key]);
    return r.rows[0] ?? null;
  },

  /** Returns null when another request created an active job first (unique partial index). */
  async insert(
    db: PoolClient,
    j: { projectId: string; userId: string; profile: 'full' | 'preview'; idempotencyKey: string | null; snapshot: unknown },
  ): Promise<RenderRow | null> {
    const r = await db.query<RenderRow>(
      `insert into public.render_jobs (project_id, user_id, profile, idempotency_key, input_snapshot)
       values ($1, $2, $3, $4, $5)
       on conflict do nothing
       returning ${COLUMNS}`,
      [j.projectId, j.userId, j.profile, j.idempotencyKey, JSON.stringify(j.snapshot)],
    );
    return r.rows[0] ?? null;
  },

  async get(db: PoolClient, userId: string, id: string): Promise<RenderRow | null> {
    const r = await db.query<RenderRow>(`select ${COLUMNS} from public.render_jobs where id = $1 and user_id = $2`, [id, userId]);
    return r.rows[0] ?? null;
  },

  async listForProject(db: PoolClient, userId: string, projectId: string): Promise<RenderRow[]> {
    const r = await db.query<RenderRow>(
      `select ${COLUMNS} from public.render_jobs where project_id = $1 and user_id = $2 order by created_at desc limit 20`,
      [projectId, userId],
    );
    return r.rows;
  },
};
