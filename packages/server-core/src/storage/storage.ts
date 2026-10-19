import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export class StorageError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message);
    this.name = 'StorageError';
  }
}

export interface SignedUrlOptions {
  expiresInSeconds: number;
  /** When set, the response asks the browser to download with this filename. */
  downloadName?: string;
}

/** Object storage adapter. Paths are opaque keys like `<userId>/uploads/<assetId>.mp4`. */
export interface StorageAdapter {
  readonly kind: 'supabase' | 'local';
  putFile(key: string, localPath: string, contentType: string): Promise<void>;
  getToFile(key: string, destPath: string): Promise<void>;
  createSignedUrl(key: string, opts: SignedUrlOptions): Promise<string>;
  remove(keys: string[]): Promise<void>;
  exists(key: string): Promise<boolean>;
}

const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,400}$/u;

/** Reject keys that could escape the storage root or address unexpected objects. */
export function assertSafeKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes('..') || key.includes('//')) {
    throw new StorageError('Invalid storage key', false);
  }
}

// ---------------------------------------------------------------------------
// Supabase Storage (private bucket, service role, signed URLs)
// ---------------------------------------------------------------------------
export class SupabaseStorage implements StorageAdapter {
  readonly kind = 'supabase' as const;
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string, private readonly bucket: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async putFile(key: string, localPath: string, contentType: string): Promise<void> {
    assertSafeKey(key);
    const size = (await stat(localPath)).size;
    const body = Readable.toWeb(createReadStream(localPath)) as unknown as ReadableStream;
    const { error } = await this.client.storage.from(this.bucket).upload(key, body, {
      contentType,
      upsert: true, // retry-safe: re-uploading the same key replaces it
      duplex: 'half',
      ...(size ? {} : {}),
    } as Parameters<ReturnType<SupabaseClient['storage']['from']>['upload']>[2]);
    if (error) throw new StorageError(`Upload failed: ${error.message}`, true);
  }

  async getToFile(key: string, destPath: string): Promise<void> {
    assertSafeKey(key);
    const { data, error } = await this.client.storage.from(this.bucket).download(key);
    if (error || !data) throw new StorageError(`Download failed: ${error?.message ?? 'no data'}`, true);
    await mkdir(path.dirname(destPath), { recursive: true });
    const tmp = `${destPath}.part`;
    await pipeline(Readable.fromWeb(data.stream() as never), createWriteStream(tmp, { mode: 0o600 }));
    await rename(tmp, destPath);
  }

  async createSignedUrl(key: string, opts: SignedUrlOptions): Promise<string> {
    assertSafeKey(key);
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(key, opts.expiresInSeconds, opts.downloadName ? { download: opts.downloadName } : undefined);
    if (error || !data) throw new StorageError(`Could not sign URL: ${error?.message ?? 'no data'}`, true);
    return data.signedUrl;
  }

  async remove(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    keys.forEach(assertSafeKey);
    const { error } = await this.client.storage.from(this.bucket).remove(keys);
    if (error) throw new StorageError(`Delete failed: ${error.message}`, true);
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    const dir = path.posix.dirname(key);
    const { data, error } = await this.client.storage.from(this.bucket).list(dir, { search: path.posix.basename(key) });
    if (error) throw new StorageError(`List failed: ${error.message}`, true);
    return (data ?? []).some((o) => o.name === path.posix.basename(key));
  }
}

// ---------------------------------------------------------------------------
// Local filesystem storage (development and tests). Signed URLs are HMAC tokens
// verified by the API's /files route.
// ---------------------------------------------------------------------------
export class LocalStorage implements StorageAdapter {
  readonly kind = 'local' as const;
  readonly root: string;

  constructor(root: string, private readonly signingSecret: string, private readonly publicBaseUrl: string) {
    this.root = path.resolve(root);
  }

  resolveKey(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new StorageError('Invalid storage key', false);
    return full;
  }

  async putFile(key: string, localPath: string): Promise<void> {
    const dest = this.resolveKey(key);
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    await pipeline(createReadStream(localPath), createWriteStream(tmp, { mode: 0o600 }));
    await rename(tmp, dest);
  }

  async getToFile(key: string, destPath: string): Promise<void> {
    const src = this.resolveKey(key);
    try {
      await stat(src);
    } catch {
      throw new StorageError('Object not found', false);
    }
    await mkdir(path.dirname(destPath), { recursive: true });
    await pipeline(createReadStream(src), createWriteStream(destPath, { mode: 0o600 }));
  }

  private sign(key: string, exp: number, dl: string): string {
    return createHmac('sha256', this.signingSecret).update(`${key}\n${exp}\n${dl}`).digest('base64url');
  }

  async createSignedUrl(key: string, opts: SignedUrlOptions): Promise<string> {
    assertSafeKey(key);
    const exp = Math.floor(Date.now() / 1000) + opts.expiresInSeconds;
    const dl = opts.downloadName ?? '';
    const params = new URLSearchParams({ exp: String(exp), sig: this.sign(key, exp, dl) });
    if (dl) params.set('dl', dl);
    return `${this.publicBaseUrl.replace(/\/$/u, '')}/files/${key}?${params.toString()}`;
  }

  /** Returns the absolute file path if the signature is valid and unexpired, else null. */
  verifySignedRequest(key: string, exp: string, sig: string, dl: string): string | null {
    try {
      assertSafeKey(key);
    } catch {
      return null;
    }
    const expNum = Number(exp);
    if (!Number.isInteger(expNum) || expNum < Math.floor(Date.now() / 1000)) return null;
    const expected = Buffer.from(this.sign(key, expNum, dl));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return this.resolveKey(key);
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) await rm(this.resolveKey(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }
}

export function storageKey(userId: string, area: 'uploads' | 'renders' | 'thumbnails' | 'voice', name: string): string {
  const key = `${userId}/${area}/${name}`;
  assertSafeKey(key);
  return key;
}
