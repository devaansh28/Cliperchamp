import { createBaseContext, createLogger, loadEnv, PgBossQueue, ConfigError } from '@clipforge/server-core';
import { createApp } from './app.js';

async function main() {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    // Variable names only; values are never printed.
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }
  const log = createLogger('api', env.LOG_LEVEL);
  const queue = await PgBossQueue.start(env.SUPABASE_DB_URL, (err) => log.error({ err }, 'queue error'));
  const ctx = createBaseContext(env, log, queue);
  const { app } = createApp(ctx);

  const server = app.listen(env.API_PORT, () => {
    log.info({ port: env.API_PORT, auth: env.AUTH_PROVIDER, storage: env.STORAGE_PROVIDER, llm: ctx.llm.provider, tts: ctx.tts.provider }, 'api listening');
  });
  server.requestTimeout = 120_000;

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    server.close();
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    await queue.stop().catch(() => undefined);
    await ctx.pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
