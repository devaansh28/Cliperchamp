# Architecture

```
Browser (apps/web)                       API (apps/api)                   Worker (apps/worker)
React + Remotion Player  ── HTTPS ──▶    Express + Zod             ──▶   pg-boss consumers
  same composition as render             auth, CRUD, quotas,              process-media, generate-voice,
  (packages/video-engine)                signed URLs, job creation        render-video, cleanup
          │                                     │                                  │
          └──── signed URLs ──▶ Storage ◀───────┴──────────────┬───────────────────┘
                                (Supabase private bucket                  │
                                 or local dir in dev)          PostgreSQL (Supabase): tables + RLS + pg-boss
```

## Data model (`supabase/migrations`)
- `profiles` (created by a trigger on `auth.users`), `projects` (script, settings, caption style,
  output profile, `revision` for optimistic concurrency), `media_assets`, `timeline_clips`,
  `caption_segments`, `render_jobs`, `usage_events`.
- Every table has RLS. Child rows use composite foreign keys `(project_id, user_id)` and
  `(asset_id, user_id)` so a row can never point at another user's project or media, even through
  the service role.
- `render_jobs`: one active job per project (partial unique index), unique `(user_id, idempotency_key)`,
  a frozen `input_snapshot`, `attempt/max_attempts`, `cancel_requested`, `heartbeat_at`,
  error category/message. Users may only `select` and `insert` jobs; the worker updates them.

## Timeline contract
`packages/shared/src/schemas/timeline.ts` defines clips (video clips play back to back by `order`,
audio clips at `startMs`), captions (with `timingSource`: estimated / aligned / imported / manual),
caption style and output profile. The API validates it on save, the worker validates it again in the
snapshot, and the composition renders exactly this data.

## Request flow: export
1. The editor flushes autosave, then `POST /api/projects/:id/renders` with an `Idempotency-Key`.
2. The API checks ownership, content, media readiness, duration and quotas; freezes a snapshot of
   the timeline and asset metadata; inserts the job (or returns the existing active one); enqueues
   `render-video`.
3. The worker claims the job (`for update`), re-verifies asset ownership, stages and probes each
   asset, normalizes anything browsers can't decode, serves the files from a loopback server with a
   per-job token, and calls Remotion `renderMedia`.
4. Progress and heartbeats go to the job row (the editor polls). Cancellation is checked on every
   progress tick.
5. The output is checked with FFprobe (codec, size, pixel format, fps, audio, duration), uploaded
   privately with a thumbnail, usage is recorded, and temp files are removed.

## Social publishing
`packages/server-core/src/social` has one adapter per platform (YouTube resumable upload, TikTok
Content Posting API, Instagram Reels containers) behind `SocialPlatformAdapter`. The API handles
OAuth (`/api/social/...`) and creates `publish_jobs` rows (one per export and account, unique);
the worker's `publish-video` job uploads, saves the platform reference as soon as it exists so
retries resume, and records the post URL. When a Full HD render completes, `queueAutoPublish`
creates posts for projects that opted in; a failure there never fails the render.

## Queue
pg-boss behind the `JobQueue` interface (`packages/server-core/src/queue`). Retries per queue,
permanent errors complete the job without retrying, a cleanup job fails stale jobs, enforces
retention and removes orphaned temp directories.

## Auth
`AUTH_PROVIDER=supabase` verifies Supabase JWTs (JWKS, or the legacy HS256 secret).
`AUTH_PROVIDER=local` is a development/test mode with scrypt passwords, 15-minute access tokens and
rotating refresh tokens; it is refused in production. Either way, the API runs user queries as the
`authenticated` role with the user's JWT claims so RLS is enforced by PostgreSQL.
