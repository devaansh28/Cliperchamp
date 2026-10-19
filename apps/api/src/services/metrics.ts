import type { Pool } from '@clipforge/server-core';

/** In-process counters; cheap monitoring without a paid service. */
export interface Metrics {
  startedAt: number;
  requests: number;
  apiErrors: number;
  storageFailures: number;
}

export function createMetrics(): Metrics {
  return { startedAt: Date.now(), requests: 0, apiErrors: 0, storageFailures: 0 };
}

export async function renderStats(pool: Pool) {
  const byStatus = await pool.query<{ status: string; count: number }>(
    `select status, count(*)::int as count from public.render_jobs where created_at > now() - interval '24 hours' group by status`,
  );
  const durations = await pool.query<{ avg_seconds: number | null; p95_seconds: number | null }>(
    `select avg(extract(epoch from completed_at - started_at))::float as avg_seconds,
            percentile_cont(0.95) within group (order by extract(epoch from completed_at - started_at))::float as p95_seconds
       from public.render_jobs where status = 'completed' and completed_at > now() - interval '24 hours'`,
  );
  const failures = await pool.query<{ error_category: string; count: number }>(
    `select error_category, count(*)::int as count from public.render_jobs
      where status = 'failed' and updated_at > now() - interval '24 hours' group by error_category`,
  );
  return {
    last24h: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.count])),
    processingSeconds: durations.rows[0] ?? { avg_seconds: null, p95_seconds: null },
    failuresByCategory: Object.fromEntries(failures.rows.map((r) => [r.error_category, r.count])),
  };
}
