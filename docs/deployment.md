# Deployment

Nothing in this repository deploys automatically. These are the steps for a production setup.

## 1. Supabase
1. Create a project. Apply migrations with `supabase link` + `supabase db push`
   (or `SUPABASE_DB_URL=... node scripts/migrate.mjs`). The migration creates the private
   `clipforge-media` bucket when the `storage` schema exists.
2. Auth: enable email/password, set the site URL and redirect URL (`https://your-app/login`).
3. Keep the service role key server-side only.

## 2. API (`apps/api`)
- Build: `npm ci && npm run build -w @clipforge/api`; run `node apps/api/dist/server.js`.
- Env: `NODE_ENV=production`, `AUTH_PROVIDER=supabase`, `STORAGE_PROVIDER=supabase`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` (use the pooler URL in session
  mode for pg-boss), `WEB_ORIGIN`, `API_BASE_URL`, `TRUST_PROXY=true` behind a load balancer,
  `METRICS_TOKEN` if you want `/health/metrics`.
- Health: `GET /health` (liveness), `GET /health/ready` (DB + queue).
- Config errors stop startup and list only the variable names.

## 3. Worker (`apps/worker`)
- Needs FFmpeg/FFprobe, fonts, and a Chromium headless shell (Remotion can download it at build
  time with `npx remotion browser ensure`). A Debian/Ubuntu image with `ffmpeg fonts-dejavu-core`
  and optionally `espeak-ng` works.
- Build: `npm ci && npm run build -w @clipforge/worker`; run `node apps/worker/dist/index.js`.
- Sizing: rendering is CPU-heavy. Start with `RENDER_CONCURRENCY=1` per 2–4 vCPUs and scale
  horizontally; pg-boss distributes jobs across workers. Set `WORKER_HEALTH_PORT` for liveness probes.
- Give the worker a writable `TEMP_RENDER_DIR` with enough space for a few renders.
- Graceful shutdown: SIGTERM stops taking jobs and waits up to 60 s.

- Social posting (optional): set `SOCIAL_TOKEN_ENCRYPTION_KEY` and each platform's credentials on
  **both** the API and the worker, register the redirect URIs, and keep the key stable (changing it
  disconnects every account). Instagram needs exports reachable over public HTTPS.

## 4. Web (`apps/web`)
- `VITE_API_BASE_URL=https://api.example.com VITE_AUTH_PROVIDER=supabase VITE_SUPABASE_URL=...
  VITE_SUPABASE_PUBLISHABLE_KEY=... npm run build -w @clipforge/web`
- Serve `apps/web/dist` as a static SPA (fallback every route to `index.html`).

## 5. Before going live
- Decide on the Remotion license (see integrations.md).
- Set real quotas, retention (`RENDER_RETENTION_DAYS`) and upload limits.
- Review provider terms (LLM, TTS, Pexels attribution).
- Back up the database; storage objects are referenced by `storage_path`.
