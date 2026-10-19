import type { Env } from './config/env.js';
import { createPool, type Pool } from './db/pool.js';
import type { Logger } from './logging/logger.js';
import { createAlignmentProvider, type AlignmentProvider } from './providers/alignment/alignment.js';
import { createScriptGenerator, type ScriptGenerator } from './providers/llm/llm.js';
import { createMediaProvider, type MediaProvider } from './providers/media/media.js';
import { createTtsProvider, type TtsProvider } from './providers/tts/tts.js';
import type { JobQueue } from './queue/queue.js';
import { LocalStorage, SupabaseStorage, type StorageAdapter } from './storage/storage.js';

/** Dependencies shared by request handlers and job handlers. Tests build their own with fakes. */
export interface ServerContext {
  env: Env;
  log: Logger;
  pool: Pool;
  storage: StorageAdapter;
  queue: JobQueue;
  llm: ScriptGenerator;
  tts: TtsProvider;
  media: MediaProvider;
  alignment: AlignmentProvider;
}

export function createStorage(env: Env): StorageAdapter {
  if (env.STORAGE_PROVIDER === 'local') {
    return new LocalStorage(env.LOCAL_STORAGE_DIR, env.STORAGE_SIGNING_SECRET!, env.API_BASE_URL);
  }
  return new SupabaseStorage(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, env.STORAGE_BUCKET);
}

export function createBaseContext(env: Env, log: Logger, queue: JobQueue): ServerContext {
  return {
    env,
    log,
    pool: createPool(env.SUPABASE_DB_URL, env.DB_POOL_MAX),
    storage: createStorage(env),
    queue,
    llm: createScriptGenerator(env),
    tts: createTtsProvider(env),
    media: createMediaProvider(env),
    alignment: createAlignmentProvider(env),
  };
}
