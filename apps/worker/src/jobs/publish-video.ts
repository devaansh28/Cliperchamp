import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  AutoPublishSchema,
  PLATFORM_RULES,
  type SocialPlatform,
} from '@clipforge/shared';
import {
  createPublishJobs,
  enqueuePublishJobs,
  ProviderNotConfiguredError,
  PublishValidationError,
  SocialAuthError,
  SocialPlatformError,
  StorageError,
  withServiceTx,
  type AccountForPublish,
  type RenderForPublish,
  type TokenSet,
} from '@clipforge/server-core';
import type { WorkerContext } from '../context.js';

interface ClaimedPost {
  id: string;
  user_id: string;
  project_id: string;
  render_job_id: string;
  social_account_id: string;
  platform: SocialPlatform;
  title: string;
  caption: string;
  privacy: 'public' | 'unlisted' | 'private';
  attempt: number;
  max_attempts: number;
  platform_ref: string | null;
}

interface AccountTokens {
  id: string;
  platform: SocialPlatform;
  external_account_id: string;
  status: string;
  access_token_enc: string;
  refresh_token_enc: string | null;
  token_expires_at: Date | null;
  scopes: string[];
}

/** Refresh tokens that expire within this window before using them. */
const REFRESH_MARGIN_MS = 5 * 60_000;

type Category = 'validation' | 'auth' | 'platform' | 'storage' | 'internal';

function classify(err: unknown): { category: Category; retryable: boolean; userMessage: string; detail: string } {
  const detail = `${(err as Error)?.name ?? 'Error'}: ${(err as Error)?.message ?? String(err)}`.slice(0, 2000);
  if (err instanceof SocialAuthError) return { category: 'auth', retryable: false, userMessage: err.userMessage, detail };
  if (err instanceof SocialPlatformError) return { category: 'platform', retryable: err.transient, userMessage: err.userMessage, detail };
  if (err instanceof PublishValidationError) return { category: 'validation', retryable: false, userMessage: err.message, detail };
  if (err instanceof ProviderNotConfiguredError) return { category: 'internal', retryable: false, userMessage: 'Posting to this platform is no longer set up on the server.', detail };
  if (err instanceof StorageError) return { category: 'storage', retryable: err.transient, userMessage: 'The exported video could not be read from storage.', detail };
  return { category: 'internal', retryable: true, userMessage: 'Something went wrong while posting. We will try again.', detail };
}

async function claim(ctx: WorkerContext, id: string): Promise<ClaimedPost | null> {
  return withServiceTx(ctx.pool, async (db) => {
    const r = await db.query<ClaimedPost & { status: string }>('select * from public.publish_jobs where id = $1 for update', [id]);
    const job = r.rows[0];
    if (!job || job.status !== 'queued') return null;
    if (job.attempt >= job.max_attempts) {
      await db.query(
        `update public.publish_jobs set status = 'failed', error_category = coalesce(error_category, 'internal'),
           error_message = coalesce(error_message, 'Posting failed after several attempts.'), completed_at = now() where id = $1`,
        [id],
      );
      return null;
    }
    await db.query(
      `update public.publish_jobs set status = 'processing', attempt = attempt + 1, started_at = now(), error_category = null, error_message = null, error_detail = null where id = $1`,
      [id],
    );
    return { ...job, attempt: job.attempt + 1 };
  });
}

/** Decrypt the account's tokens, refreshing (and re-encrypting) them when they are about to expire. */
async function usableTokens(ctx: WorkerContext, account: AccountTokens): Promise<TokenSet> {
  const cipher = ctx.social.cipher;
  if (!cipher) throw new ProviderNotConfiguredError('social', 'SOCIAL_TOKEN_ENCRYPTION_KEY is not set');
  let tokens: TokenSet = {
    accessToken: cipher.decrypt(account.access_token_enc),
    refreshToken: account.refresh_token_enc ? cipher.decrypt(account.refresh_token_enc) : null,
    expiresAt: account.token_expires_at,
    scopes: account.scopes,
  };
  if (tokens.expiresAt && tokens.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS) {
    tokens = await ctx.social.get(account.platform).refresh(tokens);
    await ctx.pool.query(
      `update public.social_accounts set access_token_enc = $2, refresh_token_enc = coalesce($3, refresh_token_enc), token_expires_at = $4 where id = $1`,
      [account.id, cipher.encrypt(tokens.accessToken), tokens.refreshToken ? cipher.encrypt(tokens.refreshToken) : null, tokens.expiresAt],
    );
  }
  return tokens;
}

/** Post one finished export to one account. Never reports success unless the platform confirmed it. */
export async function handlePublishVideo(ctx: WorkerContext, publishJobId: string): Promise<void> {
  const job = await claim(ctx, publishJobId);
  if (!job) return;
  const log = ctx.log.child({ publishJobId, platform: job.platform, attempt: job.attempt });
  const workDir = path.join(ctx.tempRoot, `publish-${job.id}`);
  try {
    // Re-check ownership and state with the service role: the account and export must belong to the job's user.
    const data = await withServiceTx(ctx.pool, async (db) => {
      const account = await db.query<AccountTokens>(
        `select id, platform, external_account_id, status, access_token_enc, refresh_token_enc, token_expires_at, scopes
           from public.social_accounts where id = $1 and user_id = $2`,
        [job.social_account_id, job.user_id],
      );
      const render = await db.query<{ status: string; output_path: string | null; output_duration_ms: number | null }>(
        'select status, output_path, output_duration_ms from public.render_jobs where id = $1 and user_id = $2',
        [job.render_job_id, job.user_id],
      );
      return { account: account.rows[0], render: render.rows[0] };
    });
    if (!data.account) throw new PublishValidationError('The account was disconnected.');
    if (data.account.platform !== job.platform) throw new PublishValidationError('Account and platform do not match.');
    if (data.account.status !== 'active') throw new SocialAuthError('account needs reconnect');
    if (!data.render || data.render.status !== 'completed' || !data.render.output_path) throw new PublishValidationError('The export is no longer available.');

    const adapter = ctx.social.get(job.platform);
    const tokens = await usableTokens(ctx, data.account);

    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const file = path.join(workDir, 'video.mp4');
    if (!job.platform_ref) await ctx.storage.getToFile(data.render.output_path, file);
    const outputPath = data.render.output_path;

    const result = await adapter.publish({
      accessToken: tokens.accessToken,
      externalAccountId: data.account.external_account_id,
      filePath: file,
      fileSize: job.platform_ref ? 0 : (await stat(file)).size,
      durationMs: data.render.output_duration_ms ?? 0,
      title: job.title,
      caption: job.caption,
      privacy: job.privacy,
      // The platform downloads this link itself; it expires after an hour.
      publicVideoUrl: () => ctx.storage.createSignedUrl(outputPath, { expiresInSeconds: 3600 }),
      onPlatformRef: async (ref) => {
        await ctx.pool.query('update public.publish_jobs set platform_ref = $2 where id = $1', [job.id, ref]);
      },
      resumeRef: job.platform_ref,
    });

    await ctx.pool.query(
      `update public.publish_jobs set status = 'published', external_post_id = $2, external_url = $3, completed_at = now() where id = $1`,
      [job.id, result.externalPostId, result.url],
    );
    log.info({ externalPostId: result.externalPostId }, 'published');
  } catch (err) {
    const c = classify(err);
    const retry = c.retryable && job.attempt < job.max_attempts;
    log.warn({ category: c.category, retry, detail: c.detail }, 'publish failed');
    if (c.category === 'auth') {
      await ctx.pool.query(`update public.social_accounts set status = 'needs_reconnect', last_error = $2 where id = $1`, [job.social_account_id, c.userMessage]);
    }
    await ctx.pool.query(
      `update public.publish_jobs set status = $2, error_category = $3, error_message = $4, error_detail = $5,
         completed_at = case when $2 = 'queued' then null else now() end where id = $1`,
      [job.id, retry ? 'queued' : 'failed', c.category, c.userMessage, c.detail],
    );
    if (retry) throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * After a Full HD export finishes: if the project opted in to auto-publishing, create one post per
 * selected, still-connected account. Problems are recorded on the posts; the export itself is unaffected.
 */
export async function queueAutoPublish(ctx: WorkerContext, renderJobId: string): Promise<number> {
  const rows = await withServiceTx(ctx.pool, async (db) => {
    const render = await db.query<RenderForPublish & { settings: unknown }>(
      `select r.id, r.user_id, r.project_id, r.status, r.profile, r.output_path, r.output_duration_ms, p.settings
         from public.render_jobs r join public.projects p on p.id = r.project_id and p.user_id = r.user_id
        where r.id = $1`,
      [renderJobId],
    );
    const row = render.rows[0];
    if (!row || row.profile !== 'full' || row.status !== 'completed') return [];
    const auto = AutoPublishSchema.safeParse((row.settings as { autoPublish?: unknown } | null)?.autoPublish ?? {});
    if (!auto.success || !auto.data.enabled || auto.data.accountIds.length === 0) return [];
    // Only the render owner's accounts (user_id filter) can be used.
    const accounts = await db.query<AccountForPublish>(
      `select id, platform, status, display_name from public.social_accounts where user_id = $1 and id = any($2::uuid[]) and status = 'active'`,
      [row.user_id, auto.data.accountIds],
    );
    const created = [];
    for (const account of accounts.rows) {
      try {
        const res = await createPublishJobs(db, { render: row, accounts: [account], details: auto.data, trigger: 'auto', scheduledAt: null });
        created.push(...res.created);
      } catch (err) {
        if (!(err instanceof PublishValidationError)) throw err;
        // Record why this account was skipped so the user sees it next to the export.
        await db.query(
          `insert into public.publish_jobs (user_id, project_id, render_job_id, social_account_id, platform, trigger, title, caption, privacy, status, error_category, error_message, completed_at)
           values ($1, $2, $3, $4, $5, 'auto', $6, $7, 'public', 'failed', 'validation', $8, now())
           on conflict (render_job_id, social_account_id) do nothing`,
          [row.user_id, row.project_id, row.id, account.id, account.platform, auto.data.title.slice(0, 100), auto.data.caption, `${PLATFORM_RULES[account.platform].label}: ${err.message}`],
        );
      }
    }
    return created;
  });
  if (rows.length) {
    const { failed } = await enqueuePublishJobs(ctx.queue, rows);
    if (failed.length) {
      await ctx.pool.query(
        `update public.publish_jobs set status = 'failed', error_category = 'internal', error_message = 'Could not queue this post. Retry it from the editor.', completed_at = now() where id = any($1::uuid[])`,
        [failed],
      );
    }
  }
  return rows.length;
}
