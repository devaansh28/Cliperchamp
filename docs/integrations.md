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
