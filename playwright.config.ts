import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end test of the real stack: API + render worker + web, with local auth, local private
 * storage, free local TTS (espeak-ng) and no paid credentials. Needs PostgreSQL, FFmpeg and Chromium.
 *   E2E_DATABASE_URL (default postgresql://postgres:postgres@127.0.0.1:5432/clipforge_e2e) is reset by scripts/e2e-prepare.mjs!
 */
const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/clipforge_e2e';
const API_PORT = 8797;
const WEB_PORT = 5183;
const dataDir = path.join(os.tmpdir(), 'clipforge-e2e');
const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (process.env.PLAYWRIGHT_BROWSERS_PATH ? '/opt/pw-browsers/chromium' : undefined);

const serverEnv = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'warn',
  SUPABASE_DB_URL: DB,
  AUTH_PROVIDER: 'local',
  AUTH_JWT_SECRET: 'e2e-only-secret-e2e-only-secret-0123456789',
  STORAGE_PROVIDER: 'local',
  LOCAL_STORAGE_DIR: path.join(dataDir, 'storage'),
  STORAGE_SIGNING_SECRET: 'e2e-signing-secret-e2e-signing-secret-0123',
  TEMP_RENDER_DIR: path.join(dataDir, 'renders'),
  API_PORT: String(API_PORT),
  // Signed URLs point at the web origin; Vite proxies /files to the API.
  API_BASE_URL: `http://localhost:${WEB_PORT}`,
  WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
  LLM_PROVIDER: 'none',
  TTS_PROVIDER: 'espeak',
  MEDIA_PROVIDER: 'none',
  RATE_LIMIT_PER_MINUTE: '5000',
  WORKER_HEALTH_PORT: '8798',
  ...(process.env.RENDER_BROWSER_EXECUTABLE ? { RENDER_BROWSER_EXECUTABLE: process.env.RENDER_BROWSER_EXECUTABLE } : {}),
};

export default defineConfig({
  testDir: './e2e',
  timeout: 6 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    acceptDownloads: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions: browserExecutable ? { executablePath: browserExecutable } : {} } }],
  webServer: [
    {
      command: 'npx tsx apps/api/src/server.ts',
      url: `http://localhost:${API_PORT}/health/ready`,
      env: serverEnv,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
    },
    {
      command: 'npx tsx apps/worker/src/index.ts',
      url: 'http://localhost:8798/health',
      env: serverEnv,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      cwd: 'apps/web',
      url: `http://localhost:${WEB_PORT}`,
      env: { API_PROXY_TARGET: `http://localhost:${API_PORT}`, VITE_AUTH_PROVIDER: 'local' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
