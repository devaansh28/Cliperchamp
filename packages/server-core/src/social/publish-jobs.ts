import type pg from 'pg';
import { PLATFORM_RULES, QUEUE_NAMES, type PublishDetails, type PublishPrivacy, type Publication, type SocialPlatform } from '@clipforge/shared';
import type { JobQueue } from '../queue/queue.js';

/** A post that cannot be accepted as requested (duration, text length, privacy). */
export class PublishValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishValidationError';
  }
}

export const MAX_SCHEDULE_DAYS = 30;

/** Check one post against the platform's rules; returns the privacy to use. */
export function validatePost(platform: SocialPlatform, details: PublishDetails, durationMs: number): PublishPrivacy {
  const rules = PLATFORM_RULES[platform];
  const seconds = durationMs / 1000;
  if (seconds > rules.maxDurationSec) throw new PublishValidationError(`${rules.label} ${rules.product} can be at most ${rules.maxDurationSec} seconds; this video is ${Math.round(seconds)} seconds.`);
  if (seconds < rules.minDurationSec) throw new PublishValidationError(`${rules.label} needs videos of at least ${rules.minDurationSec} seconds.`);
  if (rules.usesTitle && details.title.length > rules.titleMax) throw new PublishValidationError(`${rules.label} titles can be at most ${rules.titleMax} characters.`);
  if (details.caption.length > rules.captionMax) throw new PublishValidationError(`${rules.label} captions can be at most ${rules.captionMax} characters.`);
  if (rules.privacy.length === 1) return rules.privacy[0]!; // Instagram has no per-post privacy.
  if (!rules.privacy.includes(details.privacy)) throw new PublishValidationError(`${rules.label} does not support "${details.privacy}" posts. Choose ${rules.privacy.join(' or ')}.`);
  return details.privacy;
}

export interface PublishRow {
  id: string;
  user_id: string;
  project_id: string;
  render_job_id: string;
  social_account_id: string;
  platform: SocialPlatform;
  status: Publication['status'];
  trigger: 'auto' | 'manual';
  title: string;
  caption: string;
  privacy: PublishPrivacy;
  scheduled_at: Date | null;
  attempt: number;
  max_attempts: number;
  platform_ref: string | null;
  external_post_id: string | null;
  external_url: string | null;
  error_category: string | null;
  error_message: string | null;
  created_at: Date;
  completed_at: Date | null;
  account_name?: string | null;
}

export function toPublication(r: PublishRow): Publication {
  return {
    id: r.id,
    projectId: r.project_id,
    renderJobId: r.render_job_id,
    socialAccountId: r.social_account_id,
    platform: r.platform,
    accountName: r.account_name ?? null,
    status: r.status,
    trigger: r.trigger,
    title: r.title,
    caption: r.caption,
    privacy: r.privacy,
    scheduledAt: r.scheduled_at?.toISOString() ?? null,
    attempt: r.attempt,
    externalPostId: r.external_post_id,
    externalUrl: r.external_url,
    errorMessage: r.error_message,
    createdAt: r.created_at.toISOString(),
    completedAt: r.completed_at?.toISOString() ?? null,
  };
}

export interface RenderForPublish {
  id: string;
  user_id: string;
  project_id: string;
  status: string;
  profile: string;
  output_path: string | null;
  output_duration_ms: number | null;
}

export interface AccountForPublish {
  id: string;
  platform: SocialPlatform;
  status: string;
  display_name: string | null;
}

/**
 * Validates and inserts publish jobs for one finished export. Works with a user transaction (API,
 * RLS applies) or a service transaction (worker auto-publish, after its own ownership checks).
 * Existing (render, account) pairs are returned unchanged, so posting twice is impossible.
 */
export async function createPublishJobs(
  db: pg.PoolClient,
  opts: {
    render: RenderForPublish;
    accounts: AccountForPublish[];
    details: PublishDetails;
    trigger: 'auto' | 'manual';
    scheduledAt: Date | null;
  },
): Promise<{ created: PublishRow[]; existing: PublishRow[] }> {
  const { render, accounts, details } = opts;
  if (render.status !== 'completed' || !render.output_path) throw new PublishValidationError('This export has not finished yet.');
  if (render.profile !== 'full') throw new PublishValidationError('Only Full HD exports can be published. Export again in Full HD.');
  if (opts.scheduledAt && opts.scheduledAt.getTime() > Date.now() + MAX_SCHEDULE_DAYS * 86_400_000) {
    throw new PublishValidationError(`Posts can be scheduled up to ${MAX_SCHEDULE_DAYS} days ahead.`);
  }
  const created: PublishRow[] = [];
  const existing: PublishRow[] = [];
  for (const account of accounts) {
    if (account.status !== 'active') throw new PublishValidationError(`Reconnect ${account.display_name ?? PLATFORM_RULES[account.platform].label} before posting to it.`);
    const privacy = validatePost(account.platform, details, render.output_duration_ms ?? 0);
    const inserted = await db.query<PublishRow>(
      `insert into public.publish_jobs (user_id, project_id, render_job_id, social_account_id, platform, trigger, title, caption, privacy, scheduled_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (render_job_id, social_account_id) do nothing
       returning *`,
      [render.user_id, render.project_id, render.id, account.id, account.platform, opts.trigger, details.title, details.caption, privacy, opts.scheduledAt],
    );
    if (inserted.rows[0]) {
      created.push({ ...inserted.rows[0], account_name: account.display_name });
    } else {
      const prior = await db.query<PublishRow>('select * from public.publish_jobs where render_job_id = $1 and social_account_id = $2', [render.id, account.id]);
      if (prior.rows[0]) existing.push({ ...prior.rows[0], account_name: account.display_name });
    }
  }
  return { created, existing };
}

/** Queue the created jobs; scheduled posts start no earlier than their time. */
export async function enqueuePublishJobs(queue: JobQueue, rows: PublishRow[]): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  for (const row of rows) {
    try {
      const startAfter = row.scheduled_at && row.scheduled_at.getTime() > Date.now() ? row.scheduled_at : undefined;
      await queue.send(QUEUE_NAMES.publishVideo, { publishJobId: row.id }, { singletonKey: `publish:${row.id}`, ...(startAfter ? { startAfter } : {}) });
    } catch {
      failed.push(row.id);
    }
  }
  return { failed };
}
