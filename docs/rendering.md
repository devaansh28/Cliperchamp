# Rendering

## Output
1080×1920 (or 540×960 draft), 30 fps, H.264 video, AAC audio, `yuv420p` (limited range,
`colorSpace: 'bt709'`), MP4. Every output is checked with FFprobe before the job is
marked completed: container, codec, size, pixel format, frame rate (±0.5), AAC when audio is
expected, duration within tolerance and the size limit.

## Pipeline (`apps/worker/src/jobs/render-video.ts`)
1. Claim the job row (`for update`); skip if cancelled or out of attempts.
2. Re-verify every asset belongs to the job's user and the snapshot paths match the database.
3. Download each asset to a per-job temp dir; probe it; normalize to H.264/AAC MP4 when a browser
   could not decode it (`FfmpegService`).
4. Register the dir with the loopback `AssetServer` (random token, filename allow-list, Range support).
5. `selectComposition` + `renderMedia` on the cached Remotion bundle with a cancel signal and a
   timeout; progress and heartbeat are written at most once per second.
6. Validate the output, extract a thumbnail, upload both privately, mark completed, record usage.
7. Always unregister and delete the temp dir.

## Failures
Errors are classified (`validation`, `media`, `timeout`, `cancelled`, `storage`, `internal`, …).
Permanent errors fail immediately with a user-facing message (for example "One of your media files
could not be read"); transient ones are retried by pg-boss up to the job's `max_attempts`. Technical
detail is kept in `error_detail`, never shown to users. The cleanup job fails jobs whose heartbeat
stopped (crashed worker) and removes old temp directories.

## Preview parity
The editor's `@remotion/player` renders `ShortVideo` from `packages/video-engine` with the same
timeline and signed URLs to the same assets. The worker renders the same component with loopback
URLs. Fonts are loaded before the first frame (`delayRender`).

## Performance notes
- The bundle is built once per worker process.
- `RENDER_CONCURRENCY` controls parallel renders per worker; Remotion uses multiple browser tabs per
  render, so keep it low and scale workers instead.
- Drafts (540×960) render faster for quick review.
