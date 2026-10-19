# ClipForge AI — notes for Claude Code

Monorepo (npm workspaces, Node 22.19+, strict TypeScript, ESM). Read `README.md` and `docs/` first.

## Commands
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`, `npm run build`
- Tests need PostgreSQL: `TEST_DATABASE_URL` (default `postgresql://postgres:postgres@127.0.0.1:5432/clipforge_test`, it is reset).
- Worker/E2E rendering needs Chromium: set `RENDER_BROWSER_EXECUTABLE` to a headless shell if Remotion cannot download one.

## Rules that matter
- The timeline schema in `packages/shared/src/schemas/timeline.ts` is the contract between editor, API and renderer. Change it in one place and keep `packages/video-engine` as the only composition (preview and render must match).
- All user data access goes through `withUserTx` (sets `role authenticated` + JWT claims so RLS applies). Use `withServiceTx` only after an explicit ownership check, and say why in a comment.
- Never put secrets in `VITE_*` variables. Never log secret values; `SECRET_ENV_KEYS` lists them for redaction. Never commit `.env`.
- Provider integrations live behind interfaces in `packages/server-core/src/providers`. Unconfigured providers throw `ProviderNotConfiguredError` (HTTP 503 with a hint) — never return canned/fake output.
- Captions created without audio alignment must keep `timingSource: 'estimated'` and the UI must say so.
- Rendering runs only in the worker, from the frozen `input_snapshot`. Validate outputs with FFprobe before marking a job completed.
- Don't claim something works without running it. Don't push, merge or deploy without the user's approval.

## Where things are
- API routes: `apps/api/src/routes/routes.ts`; services in `apps/api/src/services`.
- Jobs: `apps/worker/src/jobs/*` (render-video is the main pipeline).
- Migrations: `supabase/migrations`; dev-only auth shim and local auth in `supabase/dev`.
- Editor state: `apps/web/src/features/editor/editor-store.ts` (undo/redo, autosave).

## Social publishing
- Adapters: `packages/server-core/src/social/*`; API: `apps/api/src/services/social-service.ts`; worker: `apps/worker/src/jobs/publish-video.ts`.
- Never mark a post published unless the platform confirmed it. Never post to real accounts in tests (use `FakeSocialAdapter` or a local fake server).
- Tokens are stored encrypted only; never return or log them.
