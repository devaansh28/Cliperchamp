# Security

## Secrets
- Secrets live only in server environment variables. `.env` is git-ignored; `.env.example` has no values.
- Only `VITE_*` variables reach the browser, and the only ones used are public (API URL, auth mode,
  Supabase URL and publishable key).
- Config errors list variable names, never values; environment values are never logged. Logs
  redact authorization headers, cookies, tokens, API keys, URLs and user-written text. Request logs
  omit query strings (signed URLs).

## Access control
- Every table has RLS. The API runs user queries as `authenticated` with the caller's JWT claims,
  so PostgreSQL enforces ownership even if an API check is missed.
- Composite foreign keys stop cross-user references (a clip cannot point at someone else's asset).
- Users cannot update render jobs or usage events; only the worker (service role) can.
- Unknown or foreign ids return 404 (no existence leaks). Tests cover cross-user access at the
  HTTP level (`apps/api/tests/api.test.ts`), the database level (`apps/api/tests/rls.test.ts`) and in
  the browser (`e2e/create-video.spec.ts`).

## Uploads and media
- File type is detected from bytes, not the extension or the client's MIME type; text renamed to
  `.mp4` is rejected with 415.
- Size limits (`UPLOAD_MAX_FILE_SIZE_MB`), duration and dimension limits, FFprobe validation and
  normalization before use. Filenames are sanitized; storage keys are `userId/area/uuid.ext` and
  validated against traversal.
- Remote downloads (stock media) only from allow-listed HTTPS hosts, with redirect host checks and a
  size cap.

## Storage
- Private bucket. Downloads and previews use short-lived signed URLs (`SIGNED_URL_TTL_SECONDS`).
- Local storage mode (development only) uses HMAC-signed URLs with expiry, served with Range support.

## Rendering
- Renders use a frozen snapshot; the worker re-checks asset ownership and storage paths.
- Media is served to Chromium from a loopback-only server with a per-job random token and filename
  allow-list. External URLs in timelines are not accepted (assets are referenced by id).
- Timeouts, cancellation, output-size limits and FFprobe validation of every output.
- FFmpeg/FFprobe/espeak are invoked with argument arrays (no shell).

## HTTP
- Security headers (nosniff, frame denial, referrer policy, CSP for API responses), strict CORS
  allow-list, JSON body limit, rate limits (stricter on auth and expensive endpoints),
  `Idempotency-Key` validation.

## Known gaps
- Local auth mode has no email verification or password reset; it is development-only by design.
- No virus scanning of uploads.
- Supabase mode is implemented but was not run end to end in the build sandbox (no Supabase
  available there); verify it in staging.
