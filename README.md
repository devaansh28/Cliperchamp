# ClipForge AI

ClipForge AI turns an idea into a captioned, voiced, vertical short video and exports a real MP4
(1080×1920, 30 fps, H.264/AAC, yuv420p). It is an original product inspired by the public feature
set of short-form video tools; see [docs/research](docs/research/) for what was studied and how.

**What works today**

- Accounts (Supabase Auth in production; a local auth mode for development and tests).
- Projects: create from a template, rename, open, duplicate, delete with confirmation, search, sort, resume.
- Script: generate with an LLM (Anthropic or any OpenAI-compatible API) validated against a schema,
  or write it by hand. No script is ever hardcoded.
- Media: upload video, images and audio (type checked from file bytes, normalized with FFmpeg),
  optional Pexels stock search with attribution.
- Voiceover: free local TTS (espeak-ng) or an OpenAI-compatible TTS API, with preview.
- Captions: from the script (timing clearly labelled *estimated*), word-aligned from narration audio
  when an alignment provider is set, SRT import/export, five original styles, keyword highlights.
- Editor: script/media/voice/captions/music/style panels, live preview, timeline with reorder, trim,
  resize, undo/redo, debounced autosave with conflict detection, inspector.
- Rendering: a separate worker renders with Remotion + FFmpeg from a frozen snapshot, reports progress,
  retries transient failures, can be cancelled, verifies the output with FFprobe, stores it privately
  and hands out short-lived signed download links.
- Social posting: connect YouTube, TikTok and Instagram accounts, then post a finished export to
  all of them at once, now or scheduled, or turn on auto-publish per project (off by default).
  Needs your own developer app on each platform; see [docs/integrations.md](docs/integrations.md#social-publishing-youtube-shorts-tiktok-instagram-reels).
- Usage limits per month (demo plan; nothing is ever charged).

The preview in the editor and the render worker use **the same composition**
(`packages/video-engine`), so what you see is what you export.

## Quick start (local)

Requirements: Node 22.19+, PostgreSQL 15+, FFmpeg/FFprobe, Chromium or Chrome (or let Remotion
download its headless shell), optionally `espeak-ng` for free voiceovers.

```bash
npm install
cp .env.example .env
# Fill AUTH_JWT_SECRET and STORAGE_SIGNING_SECRET with long random values:
#   openssl rand -base64 48
createdb clipforge            # or point SUPABASE_DB_URL at any empty database
npm run db:migrate
npm run dev                   # API :8787, worker, web :5173
```

Open http://localhost:5173, create an account and make a video. Set `TTS_PROVIDER=espeak` for free
voiceovers. Paid providers (LLM, TTS, stock, alignment) are optional; without them the app explains
what is missing and offers the manual path.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API, worker and web together |
| `npm run dev:web` / `dev:api` / `dev:worker` | One service |
| `npm run build` | Bundle API and worker, build the web app |
| `npm run typecheck` | TypeScript in every workspace |
| `npm run lint` | ESLint |
| `npm test` | Unit, API, RLS and render tests (needs PostgreSQL in `TEST_DATABASE_URL`) |
| `npm run test:e2e` | Playwright: full stack in a real browser, including a real render and download |
| `npm run db:migrate` | Apply `supabase/migrations` |
| `npm run fixtures` | Generate license-free test media with FFmpeg |

## Layout

```
apps/web               React + Vite + Tailwind editor
apps/api               Express API (Zod validation, OpenAPI at /api/openapi.json)
apps/worker            pg-boss worker: media processing, voiceovers, rendering, cleanup
packages/shared        Schemas, types, timeline and caption utilities shared by everything
packages/server-core   Config, DB, storage, providers, queue, usage (API + worker)
packages/video-engine  Remotion composition used by both preview and renderer
supabase/              Migrations (tables, RLS, storage bucket) and dev-only shims
docs/                  Architecture, development, deployment, integrations, security, rendering, testing
```

## Documentation

- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [Deployment](docs/deployment.md)
- [Integrations and licenses](docs/integrations.md)
- [Security](docs/security.md)
- [Rendering](docs/rendering.md)
- [Testing](docs/testing.md)
- [Research on the reference product](docs/research/)

## Licensing note

Remotion is free for individuals and small companies; larger companies need a Remotion company
license. Read [docs/integrations.md](docs/integrations.md#remotion-license) before deploying commercially.
