/**
 * Test helpers shared by API and worker tests. Never import from production code.
 * Requires a disposable PostgreSQL database in TEST_DATABASE_URL (it is reset!).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, type Env } from './config/env.js';
import { createBaseContext, type ServerContext } from './context.js';
import { createLogger } from './logging/logger.js';
import type { JobPayloads, JobQueue, QueueName, SendOptions } from './queue/queue.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/clipforge_test';

export function testEnv(overrides: Record<string, string> = {}): Env {
  const storageDir = mkdtempSync(path.join(os.tmpdir(), 'cf-test-storage-'));
  const renderDir = mkdtempSync(path.join(os.tmpdir(), 'cf-test-render-'));
  return loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    SUPABASE_DB_URL: TEST_DATABASE_URL,
    AUTH_PROVIDER: 'local',
    AUTH_JWT_SECRET: 'test-secret-test-secret-test-secret-0123',
    STORAGE_PROVIDER: 'local',
    LOCAL_STORAGE_DIR: storageDir,
    STORAGE_SIGNING_SECRET: 'signing-secret-signing-secret-signing-0123',
    API_BASE_URL: 'http://localhost:8787',
    TEMP_RENDER_DIR: renderDir,
    TTS_PROVIDER: 'none',
    LLM_PROVIDER: 'none',
    ...(process.env.RENDER_BROWSER_EXECUTABLE ? { RENDER_BROWSER_EXECUTABLE: process.env.RENDER_BROWSER_EXECUTABLE } : {}),
    ...overrides,
  });
}

/** Drop and re-create all app schemas, then apply migrations (plain PostgreSQL + auth shim + local auth). */
export function resetDatabase(databaseUrl = TEST_DATABASE_URL): void {
  execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/migrate.mjs'), '--reset'], {
    env: { ...process.env, SUPABASE_DB_URL: databaseUrl, AUTH_PROVIDER: 'local', NODE_ENV: 'test' },
    stdio: 'pipe',
  });
}

export interface SentJob {
  name: QueueName;
  data: unknown;
  opts?: SendOptions;
}

/** In-memory queue that records sends; tests drive handlers directly. */
export class RecordingQueue implements JobQueue {
  readonly sent: SentJob[] = [];
  async send<N extends QueueName>(name: N, data: JobPayloads[N], opts?: SendOptions): Promise<string> {
    this.sent.push({ name, data, opts });
    return `job-${this.sent.length}`;
  }
  async work(): Promise<void> {}
  async schedule(): Promise<void> {}
  async cancel(): Promise<void> {}
  async queueSize(): Promise<number> {
    return 0;
  }
  async stop(): Promise<void> {}
  take<N extends QueueName>(name: N): JobPayloads[N][] {
    const out = this.sent.filter((j) => j.name === name).map((j) => j.data as JobPayloads[N]);
    for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i]!.name === name) this.sent.splice(i, 1);
    return out;
  }
}

export function createTestContext(overrides: Record<string, string> = {}): ServerContext & { queue: RecordingQueue } {
  const env = testEnv(overrides);
  const queue = new RecordingQueue();
  const ctx = createBaseContext(env, createLogger('test', env.LOG_LEVEL), queue);
  return { ...ctx, queue };
}

export const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures/generated');

export function ensureFixtures(): void {
  execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/make-fixtures.mjs'), FIXTURES_DIR], { stdio: 'pipe' });
}
