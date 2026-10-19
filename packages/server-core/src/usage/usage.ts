import type pg from 'pg';
import type { UsageKind, UsageSummary } from '@clipforge/shared';
import type { Env } from '../config/env.js';

export class QuotaExceededError extends Error {
  constructor(readonly kind: UsageKind, readonly used: number, readonly limit: number, readonly unit: string) {
    super(`Quota exceeded for ${kind}`);
    this.name = 'QuotaExceededError';
  }
}

type Queryable = Pick<pg.PoolClient, 'query'>;

const UNITS: Record<UsageKind, string> = {
  script_generation: 'generations',
  voice_seconds: 'seconds',
  storage_bytes: 'bytes',
  render_seconds: 'seconds',
  export: 'exports',
};

export function quotaLimits(env: Env): Record<UsageKind, number> {
  return {
    script_generation: env.QUOTA_SCRIPT_GENERATIONS,
    voice_seconds: env.QUOTA_VOICE_SECONDS,
    storage_bytes: env.QUOTA_STORAGE_MB * 1024 * 1024,
    render_seconds: env.QUOTA_RENDER_SECONDS,
    export: env.QUOTA_EXPORTS,
  };
}

/** Demo quotas reset monthly (calendar month, UTC). */
export function periodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function usedThisPeriod(db: Queryable, userId: string, kind: UsageKind): Promise<number> {
  if (kind === 'storage_bytes') {
    // Storage is current total, not monthly.
    const r = await db.query<{ total: number }>(
      `select coalesce(sum(size_bytes), 0) as total from public.media_assets where user_id = $1`,
      [userId],
    );
    const renders = await db.query<{ total: number }>(
      `select coalesce(sum(output_size_bytes), 0) as total from public.render_jobs where user_id = $1 and status = 'completed'`,
      [userId],
    );
    return Number(r.rows[0]?.total ?? 0) + Number(renders.rows[0]?.total ?? 0);
  }
  const r = await db.query<{ total: number }>(
    `select coalesce(sum(quantity), 0) as total from public.usage_events where user_id = $1 and kind = $2 and created_at >= $3`,
    [userId, kind, periodStart()],
  );
  return Number(r.rows[0]?.total ?? 0);
}

export async function assertWithinQuota(db: Queryable, env: Env, userId: string, kind: UsageKind, adding: number): Promise<void> {
  const limit = quotaLimits(env)[kind];
  const used = await usedThisPeriod(db, userId, kind);
  if (used + adding > limit) throw new QuotaExceededError(kind, used, limit, UNITS[kind]);
}

export async function recordUsage(
  db: Queryable,
  e: { userId: string; kind: UsageKind; quantity: number; projectId?: string | null; renderJobId?: string | null },
): Promise<void> {
  await db.query(
    `insert into public.usage_events (user_id, kind, quantity, unit, project_id, render_job_id) values ($1, $2, $3, $4, $5, $6)`,
    [e.userId, e.kind, e.quantity, UNITS[e.kind], e.projectId ?? null, e.renderJobId ?? null],
  );
}

export async function usageSummary(db: Queryable, env: Env, userId: string): Promise<UsageSummary> {
  const limits = quotaLimits(env);
  const kinds = Object.keys(limits) as UsageKind[];
  const items = [];
  for (const kind of kinds) items.push({ kind, used: await usedThisPeriod(db, userId, kind), limit: limits[kind], unit: UNITS[kind] });
  return {
    periodStart: periodStart().toISOString(),
    items,
    note: 'Demo quotas for the free MVP. No payment is taken and these are not subscription entitlements.',
  };
}
