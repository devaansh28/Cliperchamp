import { clean, failure, fileBody, form, readJson, request, UPLOAD_TIMEOUT_MS } from './http.js';
import { SocialAuthError, SocialPlatformError, type PublishInput, type PublishResult, type SocialPlatformAdapter, type SocialProfile, type TokenSet } from './types.js';

export interface YouTubeEndpoints {
  authorize: string;
  token: string;
  revoke: string;
  api: string;
  upload: string;
}

export const YOUTUBE_ENDPOINTS: YouTubeEndpoints = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  api: 'https://www.googleapis.com/youtube/v3',
  upload: 'https://www.googleapis.com/upload/youtube/v3',
};

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

/**
 * YouTube Data API v3. Vertical videos up to 3 minutes are classified as Shorts by YouTube.
 * Note: until the Google Cloud project passes Google's API audit, uploads are forced to private.
 */
export class YouTubeAdapter implements SocialPlatformAdapter {
  readonly platform = 'youtube' as const;

  constructor(
    private readonly clientId: string | undefined,
    private readonly clientSecret: string | undefined,
    private readonly endpoints: YouTubeEndpoints = YOUTUBE_ENDPOINTS,
  ) {}

  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({
      client_id: this.clientId ?? '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${this.endpoints.authorize}?${q.toString()}`;
  }

  private async token(params: Record<string, string>, previous?: TokenSet): Promise<TokenSet> {
    const res = await request(this.endpoints.token, { method: 'POST', body: form({ client_id: this.clientId ?? '', client_secret: this.clientSecret ?? '', ...params }) }, 'YouTube');
    const body = await readJson<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string }>(res);
    if (!res.ok || !body.access_token) {
      if (body.error === 'invalid_grant') throw new SocialAuthError('YouTube invalid_grant');
      throw failure('YouTube', res, body.error ?? 'token request failed');
    }
    return {
      accessToken: body.access_token,
      // Google only returns a refresh token on the first consent; keep the old one on refresh.
      refreshToken: body.refresh_token ?? previous?.refreshToken ?? null,
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
      scopes: body.scope ? body.scope.split(' ') : (previous?.scopes ?? []),
    };
  }

  exchangeCode(code: string, redirectUri: string): Promise<TokenSet> {
    return this.token({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  }

  refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) throw new SocialAuthError('YouTube token expired and no refresh token');
    return this.token({ refresh_token: tokens.refreshToken, grant_type: 'refresh_token' }, tokens);
  }

  async fetchProfile(tokens: TokenSet): Promise<SocialProfile> {
    const res = await request(`${this.endpoints.api}/channels?part=snippet&mine=true`, { headers: { authorization: `Bearer ${tokens.accessToken}` } }, 'YouTube');
    const body = await readJson<{ items?: { id: string; snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }[] }>(res);
    if (!res.ok) throw failure('YouTube', res, 'channel lookup failed');
    const channel = body.items?.[0];
    if (!channel) throw new SocialPlatformError('YouTube account has no channel', false, 'This Google account has no YouTube channel. Create one, then connect again.');
    return { externalAccountId: channel.id, displayName: channel.snippet?.title ?? null, avatarUrl: channel.snippet?.thumbnails?.default?.url ?? null };
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    if (input.resumeRef) return { externalPostId: input.resumeRef, url: `https://www.youtube.com/shorts/${input.resumeRef}` };
    const auth = { authorization: `Bearer ${input.accessToken}` };
    const description = clean(/#shorts/iu.test(input.caption) ? input.caption : `${input.caption}\n\n#Shorts`, 5000);
    const title = clean(input.title.replace(/[<>]/gu, ''), 100) || 'New Short';
    const init = await request(
      `${this.endpoints.upload}/videos?uploadType=resumable&part=snippet,status`,
      {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(input.fileSize), 'x-upload-content-type': 'video/mp4' },
        body: JSON.stringify({
          snippet: { title, description, categoryId: '22' },
          status: { privacyStatus: input.privacy, selfDeclaredMadeForKids: false },
        }),
      },
      'YouTube',
    );
    if (!init.ok) {
      const body = await readJson<{ error?: { errors?: { reason?: string }[]; message?: string } }>(init);
      const reason = body.error?.errors?.[0]?.reason ?? body.error?.message ?? 'upload init failed';
      if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded') {
        throw new SocialPlatformError(`YouTube ${reason}`, false, 'YouTube upload limit reached for today. Try again tomorrow.');
      }
      throw failure('YouTube', init, reason);
    }
    const location = init.headers.get('location');
    if (!location) throw new SocialPlatformError('YouTube returned no upload URL', true, 'YouTube did not accept the upload. We will try again.');

    const upload = await request(
      location,
      { method: 'PUT', headers: { ...auth, 'content-type': 'video/mp4', 'content-length': String(input.fileSize) }, ...fileBody(input.filePath), timeoutMs: UPLOAD_TIMEOUT_MS },
      'YouTube',
    );
    const video = await readJson<{ id?: string; status?: { uploadStatus?: string; rejectionReason?: string } }>(upload);
    if (!upload.ok || !video.id) throw failure('YouTube', upload, 'upload failed');
    if (video.status?.uploadStatus === 'rejected') {
      throw new SocialPlatformError(`YouTube rejected: ${video.status.rejectionReason ?? ''}`, false, `YouTube rejected the video (${video.status.rejectionReason ?? 'no reason given'}).`);
    }
    await input.onPlatformRef(video.id);
    return { externalPostId: video.id, url: `https://www.youtube.com/shorts/${video.id}` };
  }

  async revoke(tokens: TokenSet): Promise<void> {
    const token = tokens.refreshToken ?? tokens.accessToken;
    await request(`${this.endpoints.revoke}?token=${encodeURIComponent(token)}`, { method: 'POST' }, 'YouTube').catch(() => undefined);
  }
}
