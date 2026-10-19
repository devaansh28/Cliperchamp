import { clean, form, isTransient, readJson, request, sleep } from './http.js';
import { SocialAuthError, SocialPlatformError, type PublishInput, type PublishResult, type SocialPlatformAdapter, type SocialProfile, type TokenSet } from './types.js';

export interface InstagramEndpoints {
  authorize: string;
  token: string;
  graph: string;
  version: string;
}

export const INSTAGRAM_ENDPOINTS: InstagramEndpoints = {
  authorize: 'https://www.instagram.com/oauth/authorize',
  token: 'https://api.instagram.com/oauth/access_token',
  graph: 'https://graph.instagram.com',
  version: 'v23.0',
};

interface GraphError {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

/**
 * Instagram API with Instagram Login (Business or Creator accounts). Reels are created from a
 * public HTTPS video URL that Instagram downloads, so the API's signed URLs must be reachable
 * from the internet (Supabase Storage, or a public API_BASE_URL).
 */
export class InstagramAdapter implements SocialPlatformAdapter {
  readonly platform = 'instagram' as const;
  statusTimeoutMs = 10 * 60_000;
  statusIntervalMs = 5_000;
  /** Tests only: accept http:// video URLs. */
  allowInsecureVideoUrl = false;

  constructor(
    private readonly appId: string | undefined,
    private readonly appSecret: string | undefined,
    private readonly endpoints: InstagramEndpoints = INSTAGRAM_ENDPOINTS,
  ) {}

  get configured(): boolean {
    return Boolean(this.appId && this.appSecret);
  }

  private get base(): string {
    return `${this.endpoints.graph}/${this.endpoints.version}`;
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({
      client_id: this.appId ?? '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'instagram_business_basic,instagram_business_content_publish',
      state,
    });
    return `${this.endpoints.authorize}?${q.toString()}`;
  }

  private graphError(res: Response, body: GraphError, label: string): Error {
    const e = body.error;
    if (e?.code === 190 || res.status === 401) return new SocialAuthError(`Instagram ${label}: ${e?.message ?? 'invalid token'}`, 'Instagram needs you to reconnect this account.');
    if (e?.code === 4 || e?.code === 17 || e?.code === 32 || e?.code === 613) return new SocialPlatformError(`Instagram rate limit ${e.code}`, true, 'Instagram is rate limiting requests. We will try again.');
    if (e?.code === 9 || e?.code === 352) return new SocialPlatformError(`Instagram ${e.code}: ${e.message ?? ''}`, false, 'Instagram limits how many posts an account can publish per day. Try again later.');
    return new SocialPlatformError(`Instagram ${label} HTTP ${res.status}: ${e?.message ?? ''}`, isTransient(res.status), `Instagram rejected the request (${e?.message ?? res.status}).`);
  }

  async exchangeCode(code: string, redirectUri: string): Promise<TokenSet> {
    const res = await request(this.endpoints.token, { method: 'POST', body: form({ client_id: this.appId ?? '', client_secret: this.appSecret ?? '', grant_type: 'authorization_code', redirect_uri: redirectUri, code }) }, 'Instagram');
    const raw = await readJson<{ access_token?: string; permissions?: string[] | string; data?: { access_token?: string; permissions?: string }[] } & GraphError>(res);
    const short = raw.access_token ?? raw.data?.[0]?.access_token;
    if (!res.ok || !short) throw this.graphError(res, raw, 'code exchange');
    // Swap the 1-hour token for a 60-day token.
    const long = await request(
      `${this.endpoints.graph}/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: this.appSecret ?? '', access_token: short }).toString()}`,
      { method: 'GET' },
      'Instagram',
    );
    const body = await readJson<{ access_token?: string; expires_in?: number } & GraphError>(long);
    if (!long.ok || !body.access_token) throw this.graphError(long, body, 'long-lived token');
    const perms = raw.permissions ?? raw.data?.[0]?.permissions ?? [];
    return {
      accessToken: body.access_token,
      // Instagram refreshes the long-lived token itself; there is no separate refresh token.
      refreshToken: null,
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
      scopes: Array.isArray(perms) ? perms : perms.split(','),
    };
  }

  async refresh(tokens: TokenSet): Promise<TokenSet> {
    const res = await request(
      `${this.endpoints.graph}/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: tokens.accessToken }).toString()}`,
      { method: 'GET' },
      'Instagram',
    );
    const body = await readJson<{ access_token?: string; expires_in?: number } & GraphError>(res);
    if (!res.ok || !body.access_token) throw this.graphError(res, body, 'token refresh');
    return { ...tokens, accessToken: body.access_token, expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : tokens.expiresAt };
  }

  async fetchProfile(tokens: TokenSet): Promise<SocialProfile> {
    const res = await request(`${this.base}/me?${new URLSearchParams({ fields: 'user_id,username,profile_picture_url', access_token: tokens.accessToken }).toString()}`, { method: 'GET' }, 'Instagram');
    const body = await readJson<{ id?: string; user_id?: string; username?: string; profile_picture_url?: string } & GraphError>(res);
    const id = body.user_id ?? body.id;
    if (!res.ok || !id) throw this.graphError(res, body, 'profile');
    return { externalAccountId: id, displayName: body.username ? `@${body.username}` : null, avatarUrl: body.profile_picture_url ?? null };
  }

  private async post<T>(path: string, accessToken: string, params: Record<string, string>): Promise<T> {
    const res = await request(`${this.base}${path}`, { method: 'POST', body: form({ ...params, access_token: accessToken }) }, 'Instagram');
    const body = await readJson<T & GraphError>(res);
    if (!res.ok || body.error) throw this.graphError(res, body, path);
    return body;
  }

  private async get<T>(path: string, accessToken: string, fields: string): Promise<T> {
    const res = await request(`${this.base}${path}?${new URLSearchParams({ fields, access_token: accessToken }).toString()}`, { method: 'GET' }, 'Instagram');
    const body = await readJson<T & GraphError>(res);
    if (!res.ok || body.error) throw this.graphError(res, body, path);
    return body;
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    // Saved refs: `media:<id>` once published, otherwise the container id (optionally `container:`-prefixed).
    if (input.resumeRef?.startsWith('media:')) return this.result(input.resumeRef.slice(6), input.accessToken);
    let containerId = input.resumeRef?.replace(/^container:/u, '') ?? null;
    if (!containerId) {
      const videoUrl = await input.publicVideoUrl();
      const url = new URL(videoUrl);
      const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
      if (!this.allowInsecureVideoUrl && (url.protocol !== 'https:' || local)) {
        throw new SocialPlatformError(
          'Instagram needs a public HTTPS video URL',
          false,
          'Instagram downloads the video from a public HTTPS link. Use Supabase Storage or set API_BASE_URL to a public HTTPS address.',
        );
      }
      const container = await this.post<{ id: string }>(`/${input.externalAccountId}/media`, input.accessToken, {
        media_type: 'REELS',
        video_url: videoUrl,
        caption: clean(input.caption, 2200),
        share_to_feed: 'true',
      });
      containerId = container.id;
      await input.onPlatformRef(containerId);
    }

    const deadline = Date.now() + this.statusTimeoutMs;
    for (;;) {
      const s = await this.get<{ status_code?: string; status?: string }>(`/${containerId}`, input.accessToken, 'status_code,status');
      if (s.status_code === 'FINISHED') break;
      // Already published by an earlier attempt that stopped before saving the result: never publish twice.
      if (s.status_code === 'PUBLISHED') return { externalPostId: containerId, url: null };
      if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
        throw new SocialPlatformError(`Instagram container ${s.status_code}: ${s.status ?? ''}`, false, `Instagram could not process the video (${s.status ?? s.status_code}).`);
      }
      if (Date.now() > deadline) throw new SocialPlatformError('Instagram processing timeout', true, 'Instagram is still processing the video. We will check again.');
      await sleep(this.statusIntervalMs);
    }
    const published = await this.post<{ id: string }>(`/${input.externalAccountId}/media_publish`, input.accessToken, { creation_id: containerId });
    await input.onPlatformRef(`media:${published.id}`);
    return this.result(published.id, input.accessToken);
  }

  private async result(mediaId: string, accessToken: string): Promise<PublishResult> {
    const media = await this.get<{ permalink?: string }>(`/${mediaId}`, accessToken, 'permalink').catch(() => ({ permalink: undefined }));
    return { externalPostId: mediaId, url: media.permalink ?? null };
  }

  async revoke(): Promise<void> {
    // Instagram Login has no token revocation endpoint; users remove the app in Instagram settings.
  }
}
