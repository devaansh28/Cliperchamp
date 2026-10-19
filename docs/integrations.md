# Integrations and licenses

All paid integrations are optional. When one is not configured the API answers
`503 integration_not_configured` with a hint, and the UI offers the manual path.
`GET /api/integrations` reports what is configured (never the keys).

| Capability | Variable | Options | Without it |
| --- | --- | --- | --- |
| Script generation | `LLM_PROVIDER` | `anthropic`, `openai-compatible`, `none` | Write the script by hand |
| Voiceover | `TTS_PROVIDER` | `espeak` (free, local), `openai-compatible`, `none` | Upload a recording |
| Stock footage | `MEDIA_PROVIDER` | `pexels`, `none` | Upload footage |
| Word-level caption timing | `ALIGN_PROVIDER` | `openai-compatible` (Whisper-style), `none` | Estimated timing (labelled) or SRT import |

## LLM
- **Anthropic**: `LLM_PROVIDER=anthropic`, `LLM_API_KEY`, optional `LLM_MODEL` (default
  `claude-opus-5-5`). Uses the official `@anthropic-ai/sdk` with structured output validated by the
  same Zod schema as manual scripts. Refusals and truncated output become clear errors. Server-side
  model fallbacks are not enabled.
- **OpenAI-compatible**: `LLM_BASE_URL`, `LLM_MODEL`, optional `LLM_API_KEY`. The response must be
  JSON matching the script schema; anything else is rejected (HTTP 502), never saved.

## TTS
- **espeak-ng**: free and offline, robotic but real. Install `espeak-ng`; `ESPEAK_PATH` if not on PATH.
- **OpenAI-compatible** `/audio/speech`: `TTS_BASE_URL`, `TTS_MODEL`, `TTS_API_KEY`.
- Generated audio is stored as a normal media asset and counts toward voice-seconds usage.

## Pexels
Free API key from pexels.com/api. Downloads are restricted to Pexels hosts. Attribution and license
text are stored on each imported asset and shown in the media list. Follow the Pexels license and API
terms (attribution, no redistribution as a stock library).

## Alignment
A Whisper-compatible `/audio/transcriptions` endpoint that returns word timestamps. Results are
stored with `timingSource: 'aligned'`.

## Remotion license
Rendering uses Remotion (`remotion`, `@remotion/player`, `@remotion/bundler`, `@remotion/renderer`,
all pinned to the same version). Remotion is source-available: individuals, non-profits and companies
up to the size threshold in Remotion's license may use it free; larger companies need a company
license. Read https://remotion.dev/license and set `REMOTION_LICENSE_KEY` if you have one. The Player
prints a license notice in the browser console; that is expected.

## Fonts and assets
Caption fonts come from Fontsource (Inter, Montserrat, Bebas Neue, Roboto Mono: SIL Open Font
License) plus DejaVu Sans on the worker. Test media is generated with FFmpeg (`npm run fixtures`);
no third-party footage is committed. No assets from the reference product are used.

## Social publishing (YouTube Shorts, TikTok, Instagram Reels)

Users connect their own accounts in **Settings → Connected accounts** and post a finished
Full HD export to several accounts at once from the editor's **Export** tab, now or scheduled
up to 30 days ahead. A project can opt in to **auto-publish**: every new Full HD export is then
posted to the chosen accounts. It is off by default, and nothing is ever posted without the
user pressing Publish or turning auto-publish on.

Each platform only works after you register a developer app there and set its credentials.
Unconfigured platforms show "Not set up on this server" and the API answers `503`.

| Platform | Variables | App setup | Scopes requested |
| --- | --- | --- | --- |
| YouTube | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | Google Cloud project, enable **YouTube Data API v3**, create an OAuth client of type *Web application* | `youtube.upload`, `youtube.readonly` |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | TikTok for Developers app with **Login Kit** and the **Content Posting API** (Direct Post) | `user.info.basic`, `video.publish` |
| Instagram | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | Meta app using **Instagram API with Instagram Login** | `instagram_business_basic`, `instagram_business_content_publish` |

All three also need `SOCIAL_TOKEN_ENCRYPTION_KEY` (32 random bytes, base64:
`openssl rand -base64 32`). Register this redirect URI on every platform:

```
<API_BASE_URL>/api/social/oauth/<youtube|tiktok|instagram>/callback
```

Platform limits that affect what users see (check each platform's current docs; they change):

- **YouTube.** Uploads from API projects that have not passed Google's audit are locked to
  *private*. The default API quota allows only a handful of uploads per day per project; ask
  Google for more quota for real use. Shorts must be vertical and at most 3 minutes long; the
  description gets `#Shorts` if it is missing.
- **TikTok.** Until your app passes TikTok's audit, posts are visible only to the creator
  (`SELF_ONLY`) and only a few users can post through it. The API rejects other privacy values
  with an "unaudited client" error, which ClipForge shows as-is.
- **Instagram.** Only professional (Business or Creator) accounts can publish. Instagram
  downloads the video from a URL, so the export must be reachable over **public HTTPS**:
  use Supabase Storage (signed URLs) or a public `API_BASE_URL` with local storage. Without App
  Review, only users with a role on your Meta app can connect. Reels are always public.
  Instagram also limits API posts per account per day.

How posting works: each account gets its own job on the `publish-video` queue (up to 3 tries
with backoff for temporary errors). As soon as a platform accepts an upload its reference is
saved, so a retry resumes instead of posting twice, and the same export can only be posted
once per account. A post is marked *Posted* only after the platform confirms it. Expired or
revoked access marks the account *Reconnect needed* and stops further posts to it.

Automated tests use in-memory adapters and local fake HTTP servers; they never contact a real
platform. Posting to real accounts has not been tested here, because it needs your own
developer apps and accounts.
