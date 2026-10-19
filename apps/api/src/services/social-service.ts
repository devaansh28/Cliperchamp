import { randomBytes } from 'node:crypto';
import {
  createPublishJobs,
  enqueuePublishJobs,
  isConfigured,
  toPublication,
  withServiceTx,
  withUserTx,
  type AccountForPublish,
  type PublishRow,
  type RenderForPublish,
  type ServerContext,
} from '@clipforge/server-core';
import { PLATFORM_RULES, SOCIAL_PLATFORMS, type Publication, type PublishRequest, type SocialAccount, type SocialPlatform, type SocialPlatformStatus } from '@clipforge/shared';
import { AppError, conflict, notFound } from '../utils/errors.js';

const STATE_TTL_MINUTES = 10;

interface AccountRow {
  id: string;
  platform: SocialPlatform;
  external_account_id: string;
  display_name: string | null;
  avatar_url: string | null;
  status: 'active' | 'needs_reconnect';
  last_error: string | null;
  created_at: Date;
}

const ACCOUNT_COLUMNS = 'id, platform, external_account_id, display_name, avatar_url, status, last_error, created_at';

function toAccount(r: AccountRow): SocialAccount {
  return {
    id: r.id,
    platform: r.platform,
    externalAccountId: r.external_account_id,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    status: r.status,
    lastError: r.last_error,
    createdAt: r.created_at.toISOString(),
  };
}

export class SocialService {
  constructor(private readonly ctx: ServerContext) {}

  platforms(): SocialPlatformStatus[] {
    return SOCIAL_PLATFORMS.map((platform) => ({ platform, label: PLATFORM_RULES[platform].label, configured: isConfigured(this.ctx.social, platform) }));
  }

  async listAccounts(userId: string): Promise<SocialAccount[]> {
    const rows = await withUserTx(this.ctx.pool, userId, (db) =>
      db.query<AccountRow>(`select ${ACCOUNT_COLUMNS} from public.social_accounts order by platform, created_at`),
    );
    return rows.rows.map(toAccount);
  }

  /** Step 1 of OAuth: a one-time state bound to this user, then the platform's consent URL. */
  async startConnect(userId: string, platform: SocialPlatform): Promise<{ authorizeUrl: string }> {
    const adapter = this.ctx.social.get(platform);
    const state = randomBytes(32).toString('base64url');
    // Service role: the states table is server-only. The user id comes from the verified token.
    await withServiceTx(this.ctx.pool, async (db) => {
      await db.query('delete from public.social_oauth_states where expires_at < now()');
      await db.query(
        `insert into public.social_oauth_states (state, user_id, platform, expires_at) values ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
        [state, userId, platform, String(STATE_TTL_MINUTES)],
      );
    });
    return { authorizeUrl: adapter.authorizeUrl(state, this.ctx.social.redirectUri(platform)) };
  }

  /** Step 2 of OAuth (browser redirect, no API token): consume the state, exchange the code, store encrypted tokens. */
  async completeConnect(platform: SocialPlatform, code: string, state: string): Promise<SocialAccount> {
    const adapter = this.ctx.social.get(platform);
    const cipher = this.ctx.social.cipher!;
    const owner = await withServiceTx(this.ctx.pool, (db) =>
      db.query<{ user_id: string }>('delete from public.social_oauth_states where state = $1 and platform = $2 and expires_at > now() returning user_id', [state, platform]),
    );
    const userId = owner.rows[0]?.user_id;
    if (!userId) throw new AppError(400, 'invalid_state', 'This connection link expired or was already used. Start again from Settings.');

    const tokens = await adapter.exchangeCode(code, this.ctx.social.redirectUri(platform));
    const profile = await adapter.fetchProfile(tokens);
    // Service role after the state check above proved which user started this flow.
    const row = await withServiceTx(this.ctx.pool, (db) =>
      db.query<AccountRow>(
        `insert into public.social_accounts (user_id, platform, external_account_id, display_name, avatar_url, scopes, access_token_enc, refresh_token_enc, token_expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (user_id, platform, external_account_id) do update set
           display_name = excluded.display_name, avatar_url = excluded.avatar_url, scopes = excluded.scopes,
           access_token_enc = excluded.access_token_enc,
           refresh_token_enc = coalesce(excluded.refresh_token_enc, public.social_accounts.refresh_token_enc),
           token_expires_at = excluded.token_expires_at, status = 'active', last_error = null
         returning ${ACCOUNT_COLUMNS}`,
        [
          userId,
          platform,
          profile.externalAccountId,
          profile.displayName,
          profile.avatarUrl,
          tokens.scopes,
          cipher.encrypt(tokens.accessToken),
          tokens.refreshToken ? cipher.encrypt(tokens.refreshToken) : null,
          tokens.expiresAt,
        ],
      ),
    );
    this.ctx.log.info({ platform, userId }, 'social account connected');
    return toAccount(row.rows[0]!);
  }

  async disconnect(userId: string, accountId: string): Promise<void> {
    const owned = await withUserTx(this.ctx.pool, userId, (db) =>
      db.query<{ platform: SocialPlatform }>('select platform from public.social_accounts where id = $1', [accountId]),
    );
    const platform = owned.rows[0]?.platform;
    if (!platform) throw notFound('Account');
    // Ownership checked above; the service role is needed to read the encrypted token for revocation.
    const tokens = await withServiceTx(this.ctx.pool, (db) =>
      db.query<{ access_token_enc: string; refresh_token_enc: string | null }>('select access_token_enc, refresh_token_enc from public.social_accounts where id = $1 and user_id = $2', [accountId, userId]),
    );
    const cipher = this.ctx.social.cipher;
    const t = tokens.rows[0];
    if (cipher && t) {
      try {
        await this.ctx.social.adapters[platform].revoke({
          accessToken: cipher.decrypt(t.access_token_enc),
          refreshToken: t.refresh_token_enc ? cipher.decrypt(t.refresh_token_enc) : null,
          expiresAt: null,
          scopes: [],
        });
      } catch (err) {
        this.ctx.log.warn({ err: { name: (err as Error).name }, platform }, 'token revoke failed; deleting anyway');
      }
    }
    await withUserTx(this.ctx.pool, userId, (db) => db.query('delete from public.social_accounts where id = $1', [accountId]));
  }

  /** Post a finished export to the chosen accounts, now or at `scheduledAt`. */
  async publish(userId: string, renderId: string, req: PublishRequest): Promise<{ created: Publication[]; existing: Publication[] }> {
    const result = await withUserTx(this.ctx.pool, userId, async (db) => {
      const render = await db.query<RenderForPublish>(
        'select id, user_id, project_id, status, profile, output_path, output_duration_ms from public.render_jobs where id = $1',
        [renderId],
      );
      if (!render.rows[0]) throw notFound('Render');
      const ids = [...new Set(req.accountIds)];
      const accounts = await db.query<AccountForPublish>('select id, platform, status, display_name from public.social_accounts where id = any($1::uuid[])', [ids]);
      if (accounts.rowCount !== ids.length) throw notFound('Account');
      const scheduledAt = req.scheduledAt ? new Date(req.scheduledAt) : null;
      return createPublishJobs(db, {
        render: render.rows[0],
        accounts: accounts.rows,
        details: { title: req.title, caption: req.caption, privacy: req.privacy },
        trigger: 'manual',
        scheduledAt: scheduledAt && scheduledAt.getTime() > Date.now() ? scheduledAt : null,
      });
    });
    const { failed } = await enqueuePublishJobs(this.ctx.queue, result.created);
    if (failed.length) await this.markEnqueueFailed(failed);
    const fresh = failed.length ? await this.listForRender(userId, renderId) : null;
    const pick = (rows: PublishRow[]) => rows.map((r) => fresh?.find((p) => p.id === r.id) ?? toPublication(r));
    return { created: pick(result.created), existing: pick(result.existing) };
  }

  private async markEnqueueFailed(ids: string[]) {
    await withServiceTx(this.ctx.pool, (db) =>
      db.query(
        `update public.publish_jobs set status = 'failed', error_category = 'internal', error_message = 'Could not queue this post. Try again.', completed_at = now() where id = any($1::uuid[])`,
        [ids],
      ),
    );
  }

  private async list(userId: string, where: string, value: string): Promise<Publication[]> {
    const rows = await withUserTx(this.ctx.pool, userId, (db) =>
      db.query<PublishRow>(
        `select p.*, a.display_name as account_name from public.publish_jobs p
           left join public.social_accounts a on a.id = p.social_account_id
          where p.${where} = $1 order by p.created_at desc limit 100`,
        [value],
      ),
    );
    return rows.rows.map(toPublication);
  }

  listForRender(userId: string, renderId: string) {
    return this.list(userId, 'render_job_id', renderId);
  }

  listForProject(userId: string, projectId: string) {
    return this.list(userId, 'project_id', projectId);
  }

  private async ownedPublication(userId: string, id: string): Promise<PublishRow> {
    const row = await withUserTx(this.ctx.pool, userId, (db) => db.query<PublishRow>('select * from public.publish_jobs where id = $1', [id]));
    if (!row.rows[0]) throw notFound('Post');
    return row.rows[0];
  }

  /** Cancel a post that has not started (including scheduled posts). */
  async cancel(userId: string, id: string): Promise<Publication> {
    const row = await this.ownedPublication(userId, id);
    if (row.status !== 'queued') throw conflict('Only posts that have not started can be cancelled.');
    // Ownership checked above; users cannot update publish jobs directly.
    const updated = await withServiceTx(this.ctx.pool, (db) =>
      db.query<PublishRow>(
        `update public.publish_jobs set status = 'cancelled', error_category = 'cancelled', error_message = 'Cancelled', completed_at = now()
          where id = $1 and user_id = $2 and status = 'queued' returning *`,
        [id, userId],
      ),
    );
    if (!updated.rows[0]) throw conflict('This post has already started.');
    return toPublication(updated.rows[0]);
  }

  /** Try a failed post again. */
  async retry(userId: string, id: string): Promise<Publication> {
    const row = await this.ownedPublication(userId, id);
    if (row.status !== 'failed') throw conflict('Only failed posts can be retried.');
    const account = await withUserTx(this.ctx.pool, userId, (db) => db.query<{ status: string }>('select status from public.social_accounts where id = $1', [row.social_account_id]));
    if (account.rows[0]?.status !== 'active') throw conflict('Reconnect this account in Settings, then retry.');
    const updated = await withServiceTx(this.ctx.pool, (db) =>
      db.query<PublishRow>(
        `update public.publish_jobs set status = 'queued', attempt = 0, scheduled_at = null, error_category = null, error_message = null, error_detail = null, completed_at = null
          where id = $1 and user_id = $2 and status = 'failed' returning *`,
        [id, userId],
      ),
    );
    if (!updated.rows[0]) throw conflict('This post changed. Refresh and try again.');
    const { failed } = await enqueuePublishJobs(this.ctx.queue, updated.rows);
    if (failed.length) await this.markEnqueueFailed(failed);
    return toPublication(updated.rows[0]);
  }
}
