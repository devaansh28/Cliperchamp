import { stat } from 'node:fs/promises';
import { clean, failure, fileBody, form, readJson, request, isTransient, sleep, UPLOAD_TIMEOUT_MS } from './http.js';
import { SocialAuthError, SocialPlatformError, type PublishInput, type PublishResult, type SocialPlatformAdapter, type SocialProfile, type TokenSet } from './types.js';

export interface TikTokEndpoints {
  authorize: string;
  api: string;
}

export const TIKTOK_ENDPOINTS: TikTokEndpoints = {
  authorize: 'https://www.tiktok.com/v2/auth/authorize/',
  api: 'https://open.tiktokapis.com',
};

const CHUNK = 10 * 1024 * 1024;
const SINGLE_UPLOAD_MAX = 64 * 1024 * 1024;

interface Envelope<T> {
  data?: T;
  error?: { code?: string; message?: string };
}

/** Chunk plan per TikTok's rules: one chunk below 64 MB, otherwise 10 MB chunks with the remainder merged into the last. */
export function tiktokChunks(size: number): { chunkSize: number; count: number } {
  if (size <= SINGLE_UPLOAD_MAX) return { chunkSize: size, count: 1 };
  const count = Math.floor(size / CHUNK);
  return { chunkSize: CHUNK, count };
}

/**
 * TikTok Content Posting API (Direct Post). Apps that have not passed TikTok's audit can only post
 * with SELF_ONLY privacy to private accounts; the error is reported clearly.
 */
export class TikTokAdapter implements SocialPlatformAdapter {
  readonly platform = 'tiktok' as const;
  /** How long to wait for TikTok to finish processing an upload. */
  statusTimeoutMs = 10 * 60_000;
  statusIntervalMs = 5_000;

  constructor(
    private readonly clientKey: string | undefined,
    private readonly clientSecret: string | undefined,
    private readonly endpoints: TikTokEndpoints = TIKTOK_ENDPOINTS,
  ) {}

  get configured(): boolean {
    return Boolean(this.clientKey && this.clientSecret);
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({ client_key: this.clientKey ?? '', scope: 'user.info.basic,video.publish', response_type: 'code', redirect_uri: redirectUri, state });
    return `${this.endpoints.authorize}?${q.toString()}`;
  }

  private async token(params: Record<string, string>, previous?: TokenSet): Promise<TokenSet> {
    const res = await request(
      `${this.endpoints.api}/v2/oauth/token/`,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ client_key: this.clientKey ?? '', client_secret: this.clientSecret ?? '', ...params }) },
      'TikTok',
    );
    const body = await readJson<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string }>(res);
    if (!res.ok || !body.access_token) {
      if (body.error === 'invalid_grant') throw new SocialAuthError('TikTok invalid_grant');
      throw failure('TikTok', res, body.error ?? 'token request failed');
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? previous?.refreshToken ?? null,
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
      scopes: body.scope ? body.scope.split(',') : (previous?.scopes ?? []),
    };
  }

  exchangeCode(code: string, redirectUri: string): Promise<TokenSet> {
    return this.token({ code, grant_type: 'authorization_code', redirect_uri: redirectUri });
  }

  refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) throw new SocialAuthError('TikTok token expired and no refresh token');
    return this.token({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, tokens);
  }

  private async api<T>(path: string, accessToken: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await request(
      `${this.endpoints.api}${path}`,
      {
        method: init.method ?? 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json; charset=UTF-8' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
      'TikTok',
    );
    const body = await readJson<Envelope<T>>(res);
    const code = body.error?.code ?? (res.ok ? 'ok' : 'http_error');
    if (code === 'ok' && res.ok && body.data) return body.data;
    if (code === 'access_token_invalid' || code === 'scope_not_authorized' || res.status === 401) {
      throw new SocialAuthError(`TikTok ${code}`, 'TikTok needs you to reconnect this account (and allow posting).');
    }
    if (code === 'unaudited_client_can_only_post_to_private_accounts' || code === 'privacy_level_option_mismatch') {
      throw new SocialPlatformError(`TikTok ${code}`, false, 'This TikTok app is not audited yet, so it can only post privately to a private account. Choose "Private" or finish TikTok\'s app review.');
    }
    if (code === 'spam_risk_too_many_posts' || code === 'spam_risk_user_banned_from_posting' || code === 'reached_active_user_cap') {
      throw new SocialPlatformError(`TikTok ${code}`, false, 'TikTok is not accepting more posts from this account right now.');
    }
    if (code === 'rate_limit_exceeded') throw new SocialPlatformError('TikTok rate limited', true, 'TikTok is busy. We will try again.');
    throw new SocialPlatformError(`TikTok ${code}: ${body.error?.message ?? ''}`, isTransient(res.status), `TikTok rejected the post (${code}).`);
  }

  async fetchProfile(tokens: TokenSet): Promise<SocialProfile> {
    const data = await this.api<{ user: { open_id: string; display_name?: string; avatar_url?: string } }>('/v2/user/info/?fields=open_id,display_name,avatar_url', tokens.accessToken, { method: 'GET' });
    return { externalAccountId: data.user.open_id, displayName: data.user.display_name ?? null, avatarUrl: data.user.avatar_url ?? null };
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    let publishId = input.resumeRef;
    if (!publishId) {
      const creator = await this.api<{ privacy_level_options?: string[]; max_video_post_duration_sec?: number }>('/v2/post/publish/creator_info/query/', input.accessToken, { body: {} });
      if (creator.max_video_post_duration_sec && input.durationMs / 1000 > creator.max_video_post_duration_sec) {
        throw new SocialPlatformError('TikTok duration limit', false, `This account can post videos up to ${creator.max_video_post_duration_sec} seconds.`);
      }
      const wanted = input.privacy === 'public' ? 'PUBLIC_TO_EVERYONE' : 'SELF_ONLY';
      const options = creator.privacy_level_options ?? [];
      if (options.length && !options.includes(wanted)) {
        throw new SocialPlatformError('TikTok privacy option unavailable', false, `TikTok does not allow "${input.privacy}" posts for this account. Allowed: ${options.join(', ')}.`);
      }
      const size = (await stat(input.filePath)).size;
      const { chunkSize, count } = tiktokChunks(size);
      const init = await this.api<{ publish_id: string; upload_url: string }>('/v2/post/publish/video/init/', input.accessToken, {
        body: {
          post_info: { title: clean(input.caption, 2200), privacy_level: wanted, disable_duet: false, disable_comment: false, disable_stitch: false },
          source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: count },
        },
      });
      publishId = init.publish_id;
      for (let i = 0; i < count; i++) {
        const start = i * chunkSize;
        const end = i === count - 1 ? size - 1 : start + chunkSize - 1;
        const res = await request(
          init.upload_url,
          {
            method: 'PUT',
            headers: { 'content-type': 'video/mp4', 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}` },
            ...fileBody(input.filePath, start, end),
            timeoutMs: UPLOAD_TIMEOUT_MS,
          },
          'TikTok',
        );
        if (!res.ok) throw failure('TikTok', res, `chunk ${i + 1}/${count} upload failed`);
      }
      // From here on TikTok owns the post; retries must only check status.
      await input.onPlatformRef(publishId);
    }
    return this.waitForPublish(input.accessToken, publishId);
  }

  private async waitForPublish(accessToken: string, publishId: string): Promise<PublishResult> {
    const deadline = Date.now() + this.statusTimeoutMs;
    while (Date.now() < deadline) {
      const s = await this.api<{ status: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] }>('/v2/post/publish/status/fetch/', accessToken, { body: { publish_id: publishId } });
      if (s.status === 'PUBLISH_COMPLETE') {
        const postId = s.publicaly_available_post_id?.[0];
        // Private posts have no public id; keep TikTok's publish id instead.
        return { externalPostId: postId ? String(postId) : publishId, url: postId ? `https://www.tiktok.com/video/${postId}` : null };
      }
      if (s.status === 'FAILED') throw new SocialPlatformError(`TikTok failed: ${s.fail_reason ?? ''}`, false, `TikTok could not publish the video (${s.fail_reason ?? 'unknown reason'}).`);
      await sleep(this.statusIntervalMs);
    }
    throw new SocialPlatformError('TikTok status timeout', true, 'TikTok is still processing the video. We will check again.');
  }

  async revoke(tokens: TokenSet): Promise<void> {
    await request(`${this.endpoints.api}/v2/oauth/revoke/`, { method: 'POST', body: form({ client_key: this.clientKey ?? '', client_secret: this.clientSecret ?? '', token: tokens.accessToken }) }, 'TikTok').catch(() => undefined);
  }
}
