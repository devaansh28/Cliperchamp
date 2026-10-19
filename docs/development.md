# Development

## Prerequisites
- Node 22.19+ and npm
- PostgreSQL 15+ (plain PostgreSQL works: `scripts/migrate.mjs` installs a small Supabase-compatible
  `auth` shim when the `auth` schema is missing), or the Supabase CLI (`supabase start`)
- FFmpeg and FFprobe on `PATH` (or `FFMPEG_PATH` / `FFPROBE_PATH`)
- Chromium/Chrome headless shell for rendering. Remotion downloads one automatically when
  `RENDER_BROWSER_EXECUTABLE` is empty and the network allows it.
- Optional: `espeak-ng` for free voiceovers (`TTS_PROVIDER=espeak`)

## First run
```bash
npm install
cp .env.example .env          # set AUTH_JWT_SECRET and STORAGE_SIGNING_SECRET (32+ chars)
createdb clipforge
npm run db:migrate
npm run dev
```
`npm run dev` starts the API on :8787, the worker, and Vite on :5173 (which proxies `/api` and
`/files` to the API). The worker bundles the Remotion composition once at startup.

## With the Supabase CLI
```bash
supabase start
# .env: SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
#       AUTH_PROVIDER=supabase, SUPABASE_URL=http://127.0.0.1:54321
#       STORAGE_PROVIDER=supabase, SUPABASE_SERVICE_ROLE_KEY=<from supabase status>
#       VITE_AUTH_PROVIDER=supabase, VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY
supabase db reset             # applies supabase/migrations and seed.sql
npm run dev
```

## Conventions
- Strict TypeScript everywhere; shared types come from `@clipforge/shared`.
- Validate every request body with Zod (`parse()` in `apps/api/src/middleware`).
- User-scoped DB work: `withUserTx`. Service role: only after an explicit ownership check.
- New provider? Implement the interface in `packages/server-core/src/providers/<kind>`, add env
  variables to `EnvSchema` and `.env.example`, and make the unconfigured path throw
  `ProviderNotConfiguredError` with a helpful hint.
- Change the composition only in `packages/video-engine`. Preview and render share it.
- Remotion Studio for composition work: `npm run studio -w @clipforge/video-engine`.
