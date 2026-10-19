import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { ProviderNotConfiguredError } from '../src/providers/errors.js';
import {
  createSocialRegistry,
  InstagramAdapter,
  isConfigured,
  PublishValidationError,
  SocialAuthError,
  SocialPlatformError,
  TikTokAdapter,
  tiktokChunks,
  TokenCipher,
  validatePost,
  YouTubeAdapter,
  type PublishInput,
  type TokenSet,
} from '../src/social/index.js';

// ---------------------------------------------------------------------------
// Local fake platform: records every request and answers from a route table.
// ---------------------------------------------------------------------------

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

type Handler = (req: Recorded) => Reply;

class FakePlatform {
  readonly requests: Recorded[] = [];
  private routes = new Map<string, Handler | Reply[]>();
  private server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const rec: Recorded = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks) };
      this.requests.push(rec);
      const reply = this.reply(rec);
      const headers: Record<string, string> = { ...reply.headers };
      let payload = reply.text ?? '';
      if (reply.json !== undefined) {
        payload = JSON.stringify(reply.json);
        headers['content-type'] = 'application/json';
      }
      res.writeHead(reply.status ?? 200, headers);
      res.end(payload);
    });
  });

  private reply(rec: Recorded): Reply {
    const route = this.routes.get(`${rec.method} ${rec.path}`);
    if (!route) return { status: 404, json: { error: { message: `no route ${rec.method} ${rec.path}` } } };
    if (typeof route === 'function') return route(rec);
    // A list of replies is consumed in order; the last one repeats.
    return route.length > 1 ? route.shift()! : route[0]!;
  }

  on(method: string, routePath: string, handler: Handler | Reply | Reply[]): this {
    this.routes.set(`${method} ${routePath}`, typeof handler === 'function' || Array.isArray(handler) ? handler : [handler]);
    return this;
  }

  reset(): void {
    this.requests.length = 0;
    this.routes.clear();
  }

  calls(method: string, routePath: string): Recorded[] {
    return this.requests.filter((r) => r.method === method && r.path === routePath);
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  start(): Promise<void> {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const fake = new FakePlatform();
let tmp: string;
let videoPath: string;
let video: Buffer;

beforeAll(async () => {
  await fake.start();
  tmp = mkdtempSync(path.join(os.tmpdir(), 'cf-social-'));
  video = randomBytes(6 * 1024 + 123);
  videoPath = path.join(tmp, 'clip.mp4');
  writeFileSync(videoPath, video);
});

afterAll(async () => {
  await fake.stop();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => fake.reset());

function publishInput(overrides: Partial<PublishInput> = {}): PublishInput & { refs: string[] } {
  const refs: string[] = [];
  return {
    accessToken: 'access-1',
    externalAccountId: 'acct-1',
    filePath: videoPath,
    fileSize: video.length,
    durationMs: 30_000,
    title: 'My <b>clip</b>',
    caption: 'Hello world',
    privacy: 'public',
    publicVideoUrl: () => Promise.resolve(`${fake.url}/files/clip.mp4`),
    onPlatformRef: (ref: string) => {
      refs.push(ref);
      return Promise.resolve();
    },
    resumeRef: null,
    refs,
    ...overrides,
  };
}

const tokens = (o: Partial<TokenSet> = {}): TokenSet => ({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: null, scopes: ['a'], ...o });

async function expectTransient(p: Promise<unknown>): Promise<SocialPlatformError> {
  const err = await p.then(
    () => expect.unreachable('expected rejection'),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SocialPlatformError);
  expect((err as SocialPlatformError).transient).toBe(true);
  return err as SocialPlatformError;
}

// ---------------------------------------------------------------------------

describe('TokenCipher', () => {
  const key = randomBytes(32).toString('base64');

  it('rejects truncated auth tags', () => {
    const c = new TokenCipher(key);
    const parts = c.encrypt('secret').split('.');
    parts[2] = Buffer.from(parts[2]!, 'base64url').subarray(0, 4).toString('base64url');
    expect(() => c.decrypt(parts.join('.'))).toThrow();
  });

  // Flip one bit of a base64url segment at the byte level (editing the text can be a no-op).
  const flip = (payload: string, index: number) => {
    const parts = payload.split('.');
    const bytes = Buffer.from(parts[index]!, 'base64url');
    bytes[0] = bytes[0]! ^ 0x01;
    parts[index] = bytes.toString('base64url');
    return parts.join('.');
  };

  it('round-trips text with a fresh IV each time and the v1 format', () => {
    const cipher = new TokenCipher(key);
    const plain = 'ya29.token-with-ünïcode-✓';
    const a = cipher.encrypt(plain);
    const b = cipher.encrypt(plain);
    expect(a).not.toBe(b);
    expect(a.split('.')).toHaveLength(4);
    expect(a.startsWith('v1.')).toBe(true);
    expect(a).not.toContain(plain);
    expect(cipher.decrypt(a)).toBe(plain);
    expect(cipher.decrypt(cipher.encrypt(''))).toBe('');
  });

  it('rejects tampered ciphertext, tampered tag, wrong key and malformed payloads', () => {
    const cipher = new TokenCipher(key);
    const payload = cipher.encrypt('secret-token');
    expect(() => cipher.decrypt(flip(payload, 3))).toThrow();
    expect(() => cipher.decrypt(flip(payload, 2))).toThrow();
    expect(() => cipher.decrypt(flip(payload, 1))).toThrow();
    expect(() => new TokenCipher(randomBytes(32).toString('base64')).decrypt(payload)).toThrow();
    expect(() => cipher.decrypt(payload.replace(/^v1/u, 'v2'))).toThrow(/Unrecognized/u);
    expect(() => cipher.decrypt('v1.abc')).toThrow(/Unrecognized/u);
  });

  it('requires a 32-byte key', () => {
    expect(() => new TokenCipher(randomBytes(16).toString('base64'))).toThrow(/32 bytes/u);
    expect(() => new TokenCipher('')).toThrow(/32 bytes/u);
  });
});

// ---------------------------------------------------------------------------

describe('YouTubeAdapter', () => {
  const endpoints = () => ({
    authorize: `${fake.url}/o/oauth2/v2/auth`,
    token: `${fake.url}/token`,
    revoke: `${fake.url}/revoke`,
    api: `${fake.url}/youtube/v3`,
    upload: `${fake.url}/upload/youtube/v3`,
  });
  const adapter = () => new YouTubeAdapter('yt-client', 'yt-secret', endpoints());

  it('is configured only with both credentials and builds an offline-consent authorize URL', () => {
    expect(new YouTubeAdapter(undefined, 'x').configured).toBe(false);
    expect(new YouTubeAdapter('x', undefined).configured).toBe(false);
    const url = new URL(adapter().authorizeUrl('state-1', 'https://app.example/cb'));
    expect(url.origin + url.pathname).toBe(endpoints().authorize);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'yt-client',
      redirect_uri: 'https://app.example/cb',
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      state: 'state-1',
    });
    expect(url.searchParams.get('scope')).toContain('youtube.upload');
  });

  it('exchanges a code and refreshes, keeping the old refresh token when none is returned', async () => {
    fake.on('POST', '/token', (req) => {
      const p = new URLSearchParams(req.body.toString());
      if (p.get('grant_type') === 'authorization_code') {
        return { json: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'a b' } };
      }
      return { json: { access_token: 'at-2', expires_in: 3600 } };
    });
    const a = adapter();
    const first = await a.exchangeCode('code-1', 'https://app.example/cb');
    expect(first).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1', scopes: ['a', 'b'] });
    expect(first.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    const exchange = new URLSearchParams(fake.requests[0]!.body.toString());
    expect(Object.fromEntries(exchange)).toMatchObject({ client_id: 'yt-client', client_secret: 'yt-secret', code: 'code-1', grant_type: 'authorization_code', redirect_uri: 'https://app.example/cb' });

    const second = await a.refresh(first);
    expect(second).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-1', scopes: ['a', 'b'] });
    expect(new URLSearchParams(fake.requests[1]!.body.toString()).get('refresh_token')).toBe('rt-1');
  });

  it('maps invalid_grant and 401 to SocialAuthError, 5xx to transient errors, and refuses refresh without a token', async () => {
    const a = adapter();
    fake.on('POST', '/token', { status: 400, json: { error: 'invalid_grant' } });
    await expect(a.refresh(tokens())).rejects.toBeInstanceOf(SocialAuthError);
    fake.on('POST', '/token', { status: 401, json: { error: 'invalid_client' } });
    await expect(a.exchangeCode('c', 'r')).rejects.toBeInstanceOf(SocialAuthError);
    fake.on('POST', '/token', { status: 503, text: 'busy' });
    await expectTransient(a.exchangeCode('c', 'r'));
    expect(() => a.refresh(tokens({ refreshToken: null }))).toThrow(SocialAuthError);
  });

  it('fetches the channel profile with a bearer token', async () => {
    fake.on('GET', '/youtube/v3/channels', { json: { items: [{ id: 'UC123', snippet: { title: 'Chan', thumbnails: { default: { url: 'https://img/x.jpg' } } } }] } });
    const profile = await adapter().fetchProfile(tokens());
    expect(profile).toEqual({ externalAccountId: 'UC123', displayName: 'Chan', avatarUrl: 'https://img/x.jpg' });
    const req = fake.requests[0]!;
    expect(req.headers.authorization).toBe('Bearer access-1');
    expect(req.query.get('mine')).toBe('true');

    fake.on('GET', '/youtube/v3/channels', { json: { items: [] } });
    const err = await adapter().fetchProfile(tokens()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialPlatformError);
    expect((err as SocialPlatformError).transient).toBe(false);
  });

  it('publishes with a resumable upload and reports the video id', async () => {
    fake.on('POST', '/upload/youtube/v3/videos', { status: 200, headers: { location: `${fake.url}/upload-session/abc` } });
    fake.on('PUT', '/upload-session/abc', { json: { id: 'vid-42', status: { uploadStatus: 'uploaded' } } });
    const input = publishInput({ privacy: 'unlisted' });
    const result = await adapter().publish(input);
    expect(result).toEqual({ externalPostId: 'vid-42', url: 'https://www.youtube.com/shorts/vid-42' });
    expect(input.refs).toEqual(['vid-42']);

    const [init] = fake.calls('POST', '/upload/youtube/v3/videos');
    expect(init!.headers.authorization).toBe('Bearer access-1');
    expect(init!.query.get('uploadType')).toBe('resumable');
    expect(init!.headers['x-upload-content-length']).toBe(String(video.length));
    const meta = JSON.parse(init!.body.toString()) as { snippet: { title: string; description: string }; status: { privacyStatus: string } };
    expect(meta.snippet.title).toBe('My bclip/b');
    expect(meta.snippet.description).toBe('Hello world\n\n#Shorts');
    expect(meta.status.privacyStatus).toBe('unlisted');

    const [upload] = fake.calls('PUT', '/upload-session/abc');
    expect(upload!.headers.authorization).toBe('Bearer access-1');
    expect(upload!.body.length).toBe(video.length);
    expect(upload!.body.equals(video)).toBe(true);
  });

  it('resumes from a saved video id without uploading again', async () => {
    const input = publishInput({ resumeRef: 'vid-old' });
    const result = await adapter().publish(input);
    expect(result.externalPostId).toBe('vid-old');
    expect(fake.requests).toHaveLength(0);
    expect(input.refs).toEqual([]);
  });

  it('maps upload failures: 401 to auth, 5xx/429 to transient, quota to permanent, rejection to permanent', async () => {
    fake.on('POST', '/upload/youtube/v3/videos', { status: 401, json: { error: { message: 'Invalid Credentials' } } });
    await expect(adapter().publish(publishInput())).rejects.toBeInstanceOf(SocialAuthError);

    fake.on('POST', '/upload/youtube/v3/videos', { status: 429, json: { error: { message: 'slow down' } } });
    await expectTransient(adapter().publish(publishInput()));

    fake.on('POST', '/upload/youtube/v3/videos', { status: 403, json: { error: { errors: [{ reason: 'quotaExceeded' }] } } });
    const quota = await adapter().publish(publishInput()).catch((e: unknown) => e);
    expect(quota).toBeInstanceOf(SocialPlatformError);
    expect((quota as SocialPlatformError).transient).toBe(false);

    fake.on('POST', '/upload/youtube/v3/videos', { status: 200, headers: { location: `${fake.url}/upload-session/x` } });
    fake.on('PUT', '/upload-session/x', { status: 500, text: 'oops' });
    const input = publishInput();
    await expectTransient(adapter().publish(input));
    expect(input.refs).toEqual([]);

    fake.on('PUT', '/upload-session/x', { json: { id: 'v', status: { uploadStatus: 'rejected', rejectionReason: 'duplicate' } } });
    const rejected = await adapter().publish(publishInput()).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(SocialPlatformError);
    expect((rejected as SocialPlatformError).transient).toBe(false);
    expect((rejected as SocialPlatformError).userMessage).toContain('duplicate');
  });

  it('revokes the refresh token and ignores failures', async () => {
    fake.on('POST', '/revoke', { status: 200, text: '' });
    await adapter().revoke(tokens());
    expect(fake.requests[0]!.query.get('token')).toBe('refresh-1');
    const unreachable = new YouTubeAdapter('a', 'b', { ...endpoints(), revoke: 'http://127.0.0.1:1/revoke' });
    await expect(unreachable.revoke(tokens())).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('tiktokChunks', () => {
  const MB = 1024 * 1024;
  it('uses one chunk up to 64 MB and 10 MB chunks (remainder in the last) above', () => {
    expect(tiktokChunks(5000)).toEqual({ chunkSize: 5000, count: 1 });
    expect(tiktokChunks(64 * MB)).toEqual({ chunkSize: 64 * MB, count: 1 });
    expect(tiktokChunks(64 * MB + 1)).toEqual({ chunkSize: 10 * MB, count: 6 });
    expect(tiktokChunks(105 * MB)).toEqual({ chunkSize: 10 * MB, count: 10 });
  });
});

describe('TikTokAdapter', () => {
  const adapter = () => {
    const a = new TikTokAdapter('tt-key', 'tt-secret', { authorize: `${fake.url}/auth`, api: fake.url });
    a.statusIntervalMs = 2;
    a.statusTimeoutMs = 2_000;
    return a;
  };
  const creatorOk = { json: { data: { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], max_video_post_duration_sec: 600 }, error: { code: 'ok' } } };
  const initOk = () => ({ json: { data: { publish_id: 'pub-7', upload_url: `${fake.url}/tt-upload/pub-7` }, error: { code: 'ok' } } });
  const status = (s: string, extra: Record<string, unknown> = {}) => ({ json: { data: { status: s, ...extra }, error: { code: 'ok' } } });

  it('treats a bare 429 as temporary', async () => {
    fake.on('POST', '/v2/post/publish/creator_info/query/', { status: 429, json: {} });
    await expectTransient(adapter().publish(publishInput()));
  });

  it('builds the authorize URL and exchanges/refreshes tokens', async () => {
    const url = new URL(adapter().authorizeUrl('st', 'https://app/cb'));
    expect(url.searchParams.get('client_key')).toBe('tt-key');
    expect(url.searchParams.get('scope')).toBe('user.info.basic,video.publish');

    fake.on('POST', '/v2/oauth/token/', (req) =>
      new URLSearchParams(req.body.toString()).get('grant_type') === 'authorization_code'
        ? { json: { access_token: 'a1', refresh_token: 'r1', expires_in: 86400, scope: 'user.info.basic,video.publish' } }
        : { json: { access_token: 'a2', expires_in: 86400 } },
    );
    const first = await adapter().exchangeCode('code', 'https://app/cb');
    expect(first).toMatchObject({ accessToken: 'a1', refreshToken: 'r1', scopes: ['user.info.basic', 'video.publish'] });
    expect(fake.requests[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const second = await adapter().refresh(first);
    expect(second).toMatchObject({ accessToken: 'a2', refreshToken: 'r1' });

    fake.on('POST', '/v2/oauth/token/', { status: 400, json: { error: 'invalid_grant' } });
    await expect(adapter().refresh(first)).rejects.toBeInstanceOf(SocialAuthError);
  });

  it('fetches the user profile', async () => {
    fake.on('GET', '/v2/user/info/', { json: { data: { user: { open_id: 'oid', display_name: 'Tik', avatar_url: 'https://a' } }, error: { code: 'ok' } } });
    expect(await adapter().fetchProfile(tokens())).toEqual({ externalAccountId: 'oid', displayName: 'Tik', avatarUrl: 'https://a' });
    expect(fake.requests[0]!.headers.authorization).toBe('Bearer access-1');
  });

  it('publishes end to end: creator info, init, chunked PUT, ref callback, status polling', async () => {
    fake.on('POST', '/v2/post/publish/creator_info/query/', creatorOk);
    fake.on('POST', '/v2/post/publish/video/init/', initOk());
    fake.on('PUT', '/tt-upload/pub-7', { status: 201, text: '' });
    fake.on('POST', '/v2/post/publish/status/fetch/', [status('PROCESSING_UPLOAD'), status('PROCESSING_DOWNLOAD'), status('PUBLISH_COMPLETE', { publicaly_available_post_id: [7_123_456] })]);
    const input = publishInput({ privacy: 'private', caption: 'Look\u0007 at this ' });
    const result = await adapter().publish(input);
    expect(result).toEqual({ externalPostId: '7123456', url: 'https://www.tiktok.com/video/7123456' });
    expect(input.refs).toEqual(['pub-7']);

    for (const r of fake.requests.filter((x) => x.method === 'POST')) expect(r.headers.authorization).toBe('Bearer access-1');
    const init = JSON.parse(fake.calls('POST', '/v2/post/publish/video/init/')[0]!.body.toString()) as {
      post_info: { title: string; privacy_level: string };
      source_info: Record<string, unknown>;
    };
    expect(init.post_info).toMatchObject({ title: 'Look at this', privacy_level: 'SELF_ONLY' });
    expect(init.source_info).toEqual({ source: 'FILE_UPLOAD', video_size: video.length, chunk_size: video.length, total_chunk_count: 1 });

    const puts = fake.calls('PUT', '/tt-upload/pub-7');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.headers['content-range']).toBe(`bytes 0-${video.length - 1}/${video.length}`);
    expect(puts[0]!.headers['content-type']).toBe('video/mp4');
    expect(puts[0]!.body.length).toBe(video.length);
    expect(puts[0]!.body.equals(video)).toBe(true);

    const polls = fake.calls('POST', '/v2/post/publish/status/fetch/');
    expect(polls).toHaveLength(3);
    expect(JSON.parse(polls[0]!.body.toString())).toEqual({ publish_id: 'pub-7' });
    // The ref is saved after the upload, before status polling.
    const order = fake.requests.map((r) => r.path);
    expect(order.indexOf('/tt-upload/pub-7')).toBeLessThan(order.indexOf('/v2/post/publish/status/fetch/'));
  });

  it('keeps the publish id for private posts without a public id', async () => {
    fake.on('POST', '/v2/post/publish/creator_info/query/', creatorOk);
    fake.on('POST', '/v2/post/publish/video/init/', initOk());
    fake.on('PUT', '/tt-upload/pub-7', { status: 201, text: '' });
    fake.on('POST', '/v2/post/publish/status/fetch/', status('PUBLISH_COMPLETE'));
    expect(await adapter().publish(publishInput({ privacy: 'private' }))).toEqual({ externalPostId: 'pub-7', url: null });
  });

  it('resumes from a saved publish id by polling status only', async () => {
    fake.on('POST', '/v2/post/publish/status/fetch/', status('PUBLISH_COMPLETE', { publicaly_available_post_id: ['99'] }));
    const input = publishInput({ resumeRef: 'pub-old' });
    expect(await adapter().publish(input)).toEqual({ externalPostId: '99', url: 'https://www.tiktok.com/video/99' });
    expect(fake.requests.map((r) => r.path)).toEqual(['/v2/post/publish/status/fetch/']);
    expect(JSON.parse(fake.requests[0]!.body.toString())).toEqual({ publish_id: 'pub-old' });
    expect(input.refs).toEqual([]);
  });

  it('fails permanently when status polling reaches FAILED', async () => {
    fake.on('POST', '/v2/post/publish/status/fetch/', [status('PROCESSING_UPLOAD'), status('FAILED', { fail_reason: 'file_format_check_failed' })]);
    const err = await adapter().publish(publishInput({ resumeRef: 'pub-1' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialPlatformError);
    expect((err as SocialPlatformError).transient).toBe(false);
    expect((err as SocialPlatformError).userMessage).toContain('file_format_check_failed');
  });

  it('times out polling with a transient error', async () => {
    fake.on('POST', '/v2/post/publish/status/fetch/', status('PROCESSING_UPLOAD'));
    const a = adapter();
    a.statusTimeoutMs = 30;
    await expectTransient(a.publish(publishInput({ resumeRef: 'pub-1' })));
  });

  it('maps 401 and access_token_invalid to SocialAuthError', async () => {
    fake.on('POST', '/v2/post/publish/creator_info/query/', { status: 401, json: { error: { code: 'access_token_invalid', message: 'expired' } } });
    await expect(adapter().publish(publishInput())).rejects.toBeInstanceOf(SocialAuthError);
    fake.on('POST', '/v2/post/publish/creator_info/query/', { status: 401, text: '' });
    await expect(adapter().publish(publishInput())).rejects.toBeInstanceOf(SocialAuthError);
  });

  it('maps 5xx and rate limiting to transient errors, unaudited apps to a permanent one', async () => {
    fake.on('POST', '/v2/post/publish/creator_info/query/', { status: 502, text: 'bad gateway' });
    await expectTransient(adapter().publish(publishInput()));
    fake.on('POST', '/v2/post/publish/creator_info/query/', { status: 429, json: { error: { code: 'rate_limit_exceeded' } } });
    await expectTransient(adapter().publish(publishInput()));

    fake.on('POST', '/v2/post/publish/creator_info/query/', creatorOk);
    fake.on('POST', '/v2/post/publish/video/init/', { status: 403, json: { error: { code: 'unaudited_client_can_only_post_to_private_accounts' } } });
    const err = await adapter().publish(publishInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialPlatformError);
    expect((err as SocialPlatformError).transient).toBe(false);
  });

  it('maps a failed chunk upload and does not save a ref', async () => {
    fake.on('POST', '/v2/post/publish/creator_info/query/', creatorOk);
    fake.on('POST', '/v2/post/publish/video/init/', initOk());
    fake.on('PUT', '/tt-upload/pub-7', { status: 503, text: '' });
    const input = publishInput();
    await expectTransient(adapter().publish(input));
    expect(input.refs).toEqual([]);
    expect(fake.calls('POST', '/v2/post/publish/status/fetch/')).toHaveLength(0);
  });

  it('enforces creator duration and privacy options before uploading', async () => {
    fake.on('POST', '/v2/post/publish/creator_info/query/', { json: { data: { privacy_level_options: ['SELF_ONLY'], max_video_post_duration_sec: 60 }, error: { code: 'ok' } } });
    await expect(adapter().publish(publishInput({ durationMs: 61_000, privacy: 'private' }))).rejects.toThrow(/duration/u);
    await expect(adapter().publish(publishInput({ privacy: 'public' }))).rejects.toThrow(/privacy/u);
    expect(fake.calls('POST', '/v2/post/publish/video/init/')).toHaveLength(0);
  });

  it('revokes best effort', async () => {
    fake.on('POST', '/v2/oauth/revoke/', { status: 500, text: '' });
    await expect(adapter().revoke(tokens())).resolves.toBeUndefined();
    expect(new URLSearchParams(fake.requests[0]!.body.toString()).get('token')).toBe('access-1');
  });
});

// ---------------------------------------------------------------------------

describe('InstagramAdapter', () => {
  const V = 'v23.0';
  const adapter = (insecure = true) => {
    const a = new InstagramAdapter('ig-app', 'ig-secret', { authorize: `${fake.url}/oauth/authorize`, token: `${fake.url}/oauth/access_token`, graph: fake.url, version: V });
    a.allowInsecureVideoUrl = insecure;
    a.statusIntervalMs = 2;
    a.statusTimeoutMs = 2_000;
    return a;
  };
  const form = (r: Recorded) => Object.fromEntries(new URLSearchParams(r.body.toString()));

  it('builds the authorize URL', () => {
    const url = new URL(adapter().authorizeUrl('st', 'https://app/cb'));
    expect(url.searchParams.get('client_id')).toBe('ig-app');
    expect(url.searchParams.get('scope')).toContain('instagram_business_content_publish');
  });

  it('exchanges a code for a long-lived token and refreshes it', async () => {
    fake.on('POST', '/oauth/access_token', { json: { data: [{ access_token: 'short', permissions: 'instagram_business_basic,instagram_business_content_publish' }] } });
    fake.on('GET', '/access_token', { json: { access_token: 'long', expires_in: 5_184_000 } });
    const t = await adapter().exchangeCode('code', 'https://app/cb');
    expect(t).toMatchObject({ accessToken: 'long', refreshToken: null, scopes: ['instagram_business_basic', 'instagram_business_content_publish'] });
    expect(form(fake.requests[0]!)).toMatchObject({ client_id: 'ig-app', client_secret: 'ig-secret', grant_type: 'authorization_code', code: 'code' });
    expect(Object.fromEntries(fake.requests[1]!.query)).toEqual({ grant_type: 'ig_exchange_token', client_secret: 'ig-secret', access_token: 'short' });

    fake.on('GET', '/refresh_access_token', { json: { access_token: 'long-2', expires_in: 5_184_000 } });
    const r = await adapter().refresh(t);
    expect(r).toMatchObject({ accessToken: 'long-2', refreshToken: null });
    expect(fake.calls('GET', '/refresh_access_token')[0]!.query.get('grant_type')).toBe('ig_refresh_token');

    fake.on('GET', '/refresh_access_token', { status: 400, json: { error: { code: 190, message: 'Session expired' } } });
    await expect(adapter().refresh(t)).rejects.toBeInstanceOf(SocialAuthError);
  });

  it('fetches /me', async () => {
    fake.on('GET', `/${V}/me`, { json: { user_id: '1784', username: 'clipper', profile_picture_url: 'https://pic' } });
    expect(await adapter().fetchProfile(tokens())).toEqual({ externalAccountId: '1784', displayName: '@clipper', avatarUrl: 'https://pic' });
    expect(fake.requests[0]!.query.get('access_token')).toBe('access-1');
  });

  it('publishes a reel end to end: container, status polling, media_publish, permalink', async () => {
    fake.on('POST', `/${V}/acct-1/media`, { json: { id: 'container-9' } });
    fake.on('GET', `/${V}/container-9`, [{ json: { status_code: 'IN_PROGRESS' } }, { json: { status_code: 'IN_PROGRESS' } }, { json: { status_code: 'FINISHED' } }]);
    fake.on('POST', `/${V}/acct-1/media_publish`, { json: { id: 'media-5' } });
    fake.on('GET', `/${V}/media-5`, { json: { permalink: 'https://www.instagram.com/reel/abc/' } });
    const input = publishInput({ caption: '  Reel caption  ' });
    const result = await adapter().publish(input);
    expect(result).toEqual({ externalPostId: 'media-5', url: 'https://www.instagram.com/reel/abc/' });
    expect(input.refs).toEqual(['container-9', 'media:media-5']);

    expect(form(fake.calls('POST', `/${V}/acct-1/media`)[0]!)).toEqual({
      media_type: 'REELS',
      video_url: `${fake.url}/files/clip.mp4`,
      caption: 'Reel caption',
      share_to_feed: 'true',
      access_token: 'access-1',
    });
    const polls = fake.calls('GET', `/${V}/container-9`);
    expect(polls).toHaveLength(3);
    expect(polls[0]!.query.get('fields')).toBe('status_code,status');
    expect(form(fake.calls('POST', `/${V}/acct-1/media_publish`)[0]!)).toEqual({ creation_id: 'container-9', access_token: 'access-1' });
    expect(fake.calls('GET', `/${V}/media-5`)[0]!.query.get('fields')).toBe('permalink');
  });

  it('still succeeds when the permalink lookup fails', async () => {
    fake.on('POST', `/${V}/acct-1/media`, { json: { id: 'c1' } });
    fake.on('GET', `/${V}/c1`, { json: { status_code: 'FINISHED' } });
    fake.on('POST', `/${V}/acct-1/media_publish`, { json: { id: 'm1' } });
    fake.on('GET', `/${V}/m1`, { status: 500, json: { error: { message: 'boom' } } });
    expect(await adapter().publish(publishInput())).toEqual({ externalPostId: 'm1', url: null });
  });

  it('resumes from a saved container without creating a new one', async () => {
    fake.on('GET', `/${V}/container-old`, { json: { status_code: 'FINISHED' } });
    fake.on('POST', `/${V}/acct-1/media_publish`, { json: { id: 'media-6' } });
    fake.on('GET', `/${V}/media-6`, { json: { permalink: 'https://www.instagram.com/reel/x/' } });
    const publicVideoUrl = vi.fn(() => Promise.resolve('https://cdn.example/v.mp4'));
    const input = publishInput({ resumeRef: 'container-old', publicVideoUrl });
    expect((await adapter().publish(input)).externalPostId).toBe('media-6');
    expect(fake.calls('POST', `/${V}/acct-1/media`)).toHaveLength(0);
    expect(publicVideoUrl).not.toHaveBeenCalled();
    expect(input.refs).toEqual(['media:media-6']);
  });

  it('never publishes twice when resuming after the post went live', async () => {
    fake.on('GET', `/${V}/container-live`, { json: { status_code: 'PUBLISHED' } });
    expect(await adapter().publish(publishInput({ resumeRef: 'container-live' }))).toEqual({ externalPostId: 'container-live', url: null });
    fake.on('GET', `/${V}/media-7`, { json: { permalink: 'https://www.instagram.com/reel/y/' } });
    expect(await adapter().publish(publishInput({ resumeRef: 'media:media-7' }))).toEqual({ externalPostId: 'media-7', url: 'https://www.instagram.com/reel/y/' });
    expect(fake.calls('POST', `/${V}/acct-1/media_publish`)).toHaveLength(0);
    expect(fake.calls('POST', `/${V}/acct-1/media`)).toHaveLength(0);
  });

  it('treats a bare 429 as temporary', async () => {
    fake.on('POST', `/${V}/acct-1/media`, { status: 429, json: {} });
    await expectTransient(adapter().publish(publishInput()));
  });

  it('fails permanently when the container reaches ERROR', async () => {
    fake.on('POST', `/${V}/acct-1/media`, { json: { id: 'c2' } });
    fake.on('GET', `/${V}/c2`, [{ json: { status_code: 'IN_PROGRESS' } }, { json: { status_code: 'ERROR', status: 'Error: unsupported codec' } }]);
    const err = await adapter().publish(publishInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialPlatformError);
    expect((err as SocialPlatformError).transient).toBe(false);
    expect((err as SocialPlatformError).userMessage).toContain('unsupported codec');
    expect(fake.calls('POST', `/${V}/acct-1/media_publish`)).toHaveLength(0);
  });

  it('times out polling with a transient error', async () => {
    fake.on('GET', `/${V}/c3`, { json: { status_code: 'IN_PROGRESS' } });
    const a = adapter();
    a.statusTimeoutMs = 30;
    await expectTransient(a.publish(publishInput({ resumeRef: 'c3' })));
  });

  it('refuses non-public video URLs unless explicitly allowed', async () => {
    const err = await adapter(false).publish(publishInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialPlatformError);
    expect((err as SocialPlatformError).transient).toBe(false);
    await expect(adapter(false).publish(publishInput({ publicVideoUrl: () => Promise.resolve('https://localhost/v.mp4') }))).rejects.toThrow(/public HTTPS/u);
    expect(fake.requests).toHaveLength(0);
  });

  it('maps 401/code 190 to auth errors, 5xx and rate-limit codes to transient errors, daily limits to permanent', async () => {
    fake.on('POST', `/${V}/acct-1/media`, { status: 401, json: { error: { message: 'bad token' } } });
    await expect(adapter().publish(publishInput())).rejects.toBeInstanceOf(SocialAuthError);
    fake.on('POST', `/${V}/acct-1/media`, { status: 400, json: { error: { code: 190, message: 'expired' } } });
    await expect(adapter().publish(publishInput())).rejects.toBeInstanceOf(SocialAuthError);

    fake.on('POST', `/${V}/acct-1/media`, { status: 500, json: { error: { message: 'internal' } } });
    await expectTransient(adapter().publish(publishInput()));
    fake.on('POST', `/${V}/acct-1/media`, { status: 400, json: { error: { code: 4, message: 'Application request limit reached' } } });
    await expectTransient(adapter().publish(publishInput()));

    fake.on('POST', `/${V}/acct-1/media`, { status: 400, json: { error: { code: 9, message: 'daily limit' } } });
    const err = await adapter().publish(publishInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialPlatformError);
    expect((err as SocialPlatformError).transient).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('social registry', () => {
  const base = {
    SUPABASE_DB_URL: 'postgresql://u:p@localhost/db',
    AUTH_PROVIDER: 'local',
    AUTH_JWT_SECRET: 'a'.repeat(40),
    STORAGE_PROVIDER: 'local',
    STORAGE_SIGNING_SECRET: 'b'.repeat(40),
    API_BASE_URL: 'https://api.example.com/',
  };
  const key = randomBytes(32).toString('base64');

  it('throws ProviderNotConfiguredError for unconfigured platforms', () => {
    const registry = createSocialRegistry(loadEnv(base));
    expect(registry.cipher).toBeNull();
    for (const p of ['youtube', 'tiktok', 'instagram'] as const) {
      expect(isConfigured(registry, p)).toBe(false);
      expect(() => registry.get(p)).toThrow(ProviderNotConfiguredError);
    }
  });

  it('needs both credentials and the encryption key', () => {
    const registry = createSocialRegistry(loadEnv({ ...base, SOCIAL_TOKEN_ENCRYPTION_KEY: key, YOUTUBE_CLIENT_ID: 'id', YOUTUBE_CLIENT_SECRET: 'secret' }));
    expect(registry.cipher).toBeInstanceOf(TokenCipher);
    expect(isConfigured(registry, 'youtube')).toBe(true);
    expect(registry.get('youtube')).toBeInstanceOf(YouTubeAdapter);
    expect(isConfigured(registry, 'tiktok')).toBe(false);
    try {
      registry.get('tiktok');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderNotConfiguredError);
      expect((err as ProviderNotConfiguredError).hint).toContain('TIKTOK_CLIENT_KEY');
    }
    expect(registry.redirectUri('instagram')).toBe('https://api.example.com/api/social/oauth/instagram/callback');
  });

  it('accepts injected adapters', () => {
    const custom = new TikTokAdapter('k', 's', { authorize: 'http://x', api: 'http://x' });
    const registry = createSocialRegistry(loadEnv({ ...base, SOCIAL_TOKEN_ENCRYPTION_KEY: key }), { tiktok: custom });
    expect(registry.get('tiktok')).toBe(custom);
    expect(() => registry.get('instagram')).toThrow(ProviderNotConfiguredError);
  });
});

// ---------------------------------------------------------------------------

describe('validatePost', () => {
  const details = (o: Partial<{ title: string; caption: string; privacy: 'public' | 'unlisted' | 'private' }> = {}) => ({ title: 't', caption: 'c', privacy: 'public' as const, ...o });

  it('enforces duration limits per platform', () => {
    expect(validatePost('youtube', details(), 180_000)).toBe('public');
    expect(() => validatePost('youtube', details(), 181_000)).toThrow(PublishValidationError);
    expect(() => validatePost('youtube', details(), 500)).toThrow(/at least 1 seconds/u);
    expect(validatePost('tiktok', details(), 600_000)).toBe('public');
    expect(() => validatePost('tiktok', details(), 600_001)).toThrow(/600 seconds/u);
    expect(() => validatePost('tiktok', details(), 2_000)).toThrow(PublishValidationError);
    expect(() => validatePost('instagram', details(), 900_001)).toThrow(PublishValidationError);
  });

  it('enforces title and caption limits', () => {
    expect(() => validatePost('youtube', details({ title: 'x'.repeat(101) }), 30_000)).toThrow(/titles/u);
    // Platforms without titles ignore them.
    expect(validatePost('tiktok', details({ title: 'x'.repeat(101) }), 30_000)).toBe('public');
    expect(() => validatePost('youtube', details({ caption: 'x'.repeat(5001) }), 30_000)).toThrow(/captions/u);
    expect(validatePost('youtube', details({ caption: 'x'.repeat(5000) }), 30_000)).toBe('public');
    expect(() => validatePost('tiktok', details({ caption: 'x'.repeat(2201) }), 30_000)).toThrow(/captions/u);
  });

  it('applies privacy rules, with Instagram always public', () => {
    expect(validatePost('youtube', details({ privacy: 'unlisted' }), 30_000)).toBe('unlisted');
    expect(validatePost('tiktok', details({ privacy: 'private' }), 30_000)).toBe('private');
    expect(() => validatePost('tiktok', details({ privacy: 'unlisted' }), 30_000)).toThrow(/does not support "unlisted"/u);
    expect(validatePost('instagram', details({ privacy: 'private' }), 30_000)).toBe('public');
  });
});

afterEach(() => vi.restoreAllMocks());
