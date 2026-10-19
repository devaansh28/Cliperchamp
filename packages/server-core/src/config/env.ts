import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');
/** Blank values in .env files mean "not set". */
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(blank, z.coerce.number().int().min(min).max(max).default(def));
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

/** Every variable the API and worker read. Secrets are never logged. */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  API_PORT: int(8787, 1, 65535),
  API_BASE_URL: z.string().url().default('http://localhost:8787'),
  TRUST_PROXY: bool.default(false),

  AUTH_PROVIDER: z.enum(['supabase', 'local']).default('supabase'),
  /** Only for AUTH_PROVIDER=local (development/testing). */
  AUTH_JWT_SECRET: optionalString,

  SUPABASE_URL: optionalString,
  /** Legacy HS256 JWT secret. When unset, tokens are verified against the project's JWKS. */
  SUPABASE_JWT_SECRET: optionalString,
  /** Server-only. Used for Storage. Never expose to the browser. */
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  SUPABASE_DB_URL: z.string().min(1, 'SUPABASE_DB_URL is required'),
  DB_POOL_MAX: int(10, 1, 100),

  STORAGE_PROVIDER: z.enum(['supabase', 'local']).default('supabase'),
  STORAGE_BUCKET: z.string().default('clipforge-media'),
  LOCAL_STORAGE_DIR: z.string().default('.data/storage'),
  /** HMAC secret for local signed URLs. */
  STORAGE_SIGNING_SECRET: optionalString,
  SIGNED_URL_TTL_SECONDS: int(900, 30, 86400),
  UPLOAD_MAX_FILE_SIZE_MB: int(200, 1, 2048),

  LLM_PROVIDER: z.enum(['none', 'anthropic', 'openai-compatible']).default('none'),
  LLM_API_KEY: optionalString,
  LLM_MODEL: optionalString,
  LLM_BASE_URL: optionalString,

  TTS_PROVIDER: z.enum(['none', 'espeak', 'openai-compatible']).default('none'),
  TTS_API_KEY: optionalString,
  TTS_MODEL: optionalString,
  TTS_BASE_URL: optionalString,
  ESPEAK_PATH: z.string().default('espeak-ng'),

  MEDIA_PROVIDER: z.enum(['none', 'pexels']).default('none'),
  MEDIA_API_KEY: optionalString,

  ALIGN_PROVIDER: z.enum(['none', 'openai-compatible']).default('none'),
  ALIGN_API_KEY: optionalString,
  ALIGN_MODEL: optionalString,
  ALIGN_BASE_URL: optionalString,

  RENDER_CONCURRENCY: int(1, 1, 8),
  /** Optional port for the worker's liveness endpoint (GET /health). Disabled when unset. */
  WORKER_HEALTH_PORT: z.preprocess(blank, z.coerce.number().int().min(1).max(65535).optional()),
  RENDER_MAX_DURATION_SECONDS: int(180, 5, 1800),
  RENDER_MAX_FILE_SIZE_MB: int(500, 1, 4096),
  RENDER_TIMEOUT_SECONDS: int(1800, 30, 7200),
  RENDER_RETENTION_DAYS: int(14, 1, 365),
  RENDER_BROWSER_EXECUTABLE: optionalString,
  RENDER_GL: z.preprocess(blank, z.enum(['swangle', 'angle', 'egl', 'swiftshader', 'vulkan', 'angle-egl']).optional()),
  TEMP_RENDER_DIR: z.string().default('.tmp/renders'),
  /** Remotion company license key (required for companies above Remotion's free-license threshold). */
  REMOTION_LICENSE_KEY: optionalString,
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),

  QUOTA_SCRIPT_GENERATIONS: int(50),
  QUOTA_VOICE_SECONDS: int(1800),
  QUOTA_STORAGE_MB: int(2048),
  QUOTA_RENDER_SECONDS: int(3600),
  QUOTA_EXPORTS: int(50),

  RATE_LIMIT_PER_MINUTE: int(300, 1),
  /** Bearer token for /health/metrics. Without it, metrics are disabled in production. */
  METRICS_TOKEN: optionalString,
});

export type Env = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

/** Parse and cross-check environment variables. Throws ConfigError listing variable names only, never values. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`));
  }
  const env = parsed.data;
  const problems: string[] = [];
  const prod = env.NODE_ENV === 'production';

  if (env.AUTH_PROVIDER === 'local') {
    if (prod) problems.push('AUTH_PROVIDER=local is for development and tests only; use supabase in production');
    if (!env.AUTH_JWT_SECRET || env.AUTH_JWT_SECRET.length < 32) problems.push('AUTH_JWT_SECRET must be at least 32 characters when AUTH_PROVIDER=local');
  } else if (!env.SUPABASE_URL) {
    problems.push('SUPABASE_URL is required when AUTH_PROVIDER=supabase');
  }

  if (env.STORAGE_PROVIDER === 'supabase') {
    if (!env.SUPABASE_URL) problems.push('SUPABASE_URL is required when STORAGE_PROVIDER=supabase');
    if (!env.SUPABASE_SERVICE_ROLE_KEY) problems.push('SUPABASE_SERVICE_ROLE_KEY is required when STORAGE_PROVIDER=supabase');
  } else {
    if (!env.STORAGE_SIGNING_SECRET || env.STORAGE_SIGNING_SECRET.length < 32) problems.push('STORAGE_SIGNING_SECRET must be at least 32 characters when STORAGE_PROVIDER=local');
    if (prod) problems.push('STORAGE_PROVIDER=local is not supported in production; use supabase (or another S3-compatible adapter)');
  }

  if (env.LLM_PROVIDER !== 'none') {
    if (!env.LLM_API_KEY && env.LLM_PROVIDER === 'anthropic') problems.push('LLM_API_KEY is required for LLM_PROVIDER=anthropic');
    if (env.LLM_PROVIDER === 'openai-compatible' && !env.LLM_BASE_URL) problems.push('LLM_BASE_URL is required for LLM_PROVIDER=openai-compatible');
    if (env.LLM_PROVIDER === 'openai-compatible' && !env.LLM_MODEL) problems.push('LLM_MODEL is required for LLM_PROVIDER=openai-compatible');
  }
  if (env.TTS_PROVIDER === 'openai-compatible' && (!env.TTS_BASE_URL || !env.TTS_MODEL)) problems.push('TTS_BASE_URL and TTS_MODEL are required for TTS_PROVIDER=openai-compatible');
  if (env.MEDIA_PROVIDER === 'pexels' && !env.MEDIA_API_KEY) problems.push('MEDIA_API_KEY is required for MEDIA_PROVIDER=pexels');
  if (env.ALIGN_PROVIDER === 'openai-compatible' && (!env.ALIGN_BASE_URL || !env.ALIGN_MODEL)) problems.push('ALIGN_BASE_URL and ALIGN_MODEL are required for ALIGN_PROVIDER=openai-compatible');

  if (problems.length > 0) throw new ConfigError(problems);
  return env;
}

/** Names of secret variables; used to redact logs. */
export const SECRET_ENV_KEYS = [
  'AUTH_JWT_SECRET',
  'SUPABASE_JWT_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL',
  'STORAGE_SIGNING_SECRET',
  'LLM_API_KEY',
  'TTS_API_KEY',
  'MEDIA_API_KEY',
  'ALIGN_API_KEY',
  'REMOTION_LICENSE_KEY',
  'METRICS_TOKEN',
] as const;
