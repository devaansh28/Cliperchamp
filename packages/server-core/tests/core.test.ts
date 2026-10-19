import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv } from '../src/config/env.js';
import { sniffBuffer } from '../src/media/sniff.js';
import { assertSafeKey, LocalStorage, storageKey } from '../src/storage/storage.js';

const base = {
  SUPABASE_DB_URL: 'postgresql://u:p@localhost/db',
  AUTH_PROVIDER: 'local',
  AUTH_JWT_SECRET: 'a'.repeat(40),
  STORAGE_PROVIDER: 'local',
  STORAGE_SIGNING_SECRET: 'b'.repeat(40),
};

describe('environment validation', () => {
  it('loads a valid development configuration and treats blanks as unset', () => {
    const env = loadEnv({ ...base, RENDER_GL: '', WORKER_HEALTH_PORT: '', API_PORT: '' });
    expect(env).toMatchObject({ API_PORT: 8787, LLM_PROVIDER: 'none' });
    expect(env.RENDER_GL).toBeUndefined();
  });

  it('refuses development-only modes in production and names problems without values', () => {
    const secret = 'super-secret-value-that-must-not-leak-123';
    try {
      loadEnv({ ...base, NODE_ENV: 'production', AUTH_JWT_SECRET: secret, LLM_PROVIDER: 'anthropic' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/AUTH_PROVIDER=local/u);
      expect(msg).toMatch(/STORAGE_PROVIDER=local/u);
      expect(msg).toMatch(/LLM_API_KEY is required/u);
      expect(msg).not.toContain(secret);
    }
  });

  it('requires Supabase settings for Supabase mode', () => {
    expect(() => loadEnv({ SUPABASE_DB_URL: 'postgresql://x', AUTH_PROVIDER: 'supabase', STORAGE_PROVIDER: 'supabase' })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/u);
  });
});

describe('storage keys and signed URLs', () => {
  it('rejects traversal and odd keys', () => {
    for (const bad of ['../x', 'a/../../b', '/abs', 'a//b', 'a\\b', '']) expect(() => assertSafeKey(bad)).toThrow();
    expect(() => assertSafeKey(storageKey('u1', 'uploads', 'f.mp4'))).not.toThrow();
  });

  it('signs URLs that expire and cannot be altered', async () => {
    const storage = new LocalStorage(mkdtempSync(path.join(os.tmpdir(), 'cf-core-')), 'c'.repeat(40), 'http://localhost:8787');
    const key = 'user/uploads/file.mp4';
    const url = new URL(await storage.createSignedUrl(key, { expiresInSeconds: 60, downloadName: 'clip.mp4' }));
    const q = (k: string) => url.searchParams.get(k) ?? '';
    expect(storage.verifySignedRequest(key, q('exp'), q('sig'), q('dl'))).toBe(storage.resolveKey(key));
    expect(storage.verifySignedRequest('user/uploads/other.mp4', q('exp'), q('sig'), q('dl'))).toBeNull();
    expect(storage.verifySignedRequest(key, String(Number(q('exp')) + 100), q('sig'), q('dl'))).toBeNull();
    expect(storage.verifySignedRequest(key, q('exp'), q('sig'), 'evil.html')).toBeNull();
    const expired = new URL(await storage.createSignedUrl(key, { expiresInSeconds: -10 }));
    expect(storage.verifySignedRequest(key, expired.searchParams.get('exp') ?? '', expired.searchParams.get('sig') ?? '', '')).toBeNull();
  });
});

describe('media sniffing', () => {
  it('detects real formats from bytes and ignores names', () => {
    expect(sniffBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))?.mime).toBe('image/png');
    expect(sniffBuffer(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00\x00\x00', 'binary'))?.kind).toBe('audio');
    expect(sniffBuffer(Buffer.from('this is not a video at all'))).toBeNull();
  });
});
