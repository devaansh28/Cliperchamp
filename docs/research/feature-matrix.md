# Feature matrix

Classification key:
- **Observed**: stated on a public page (fallback fetch, not REA).
- **Reproducible**: we can build it with our own implementation.
- **External**: needs a third-party integration (API key or service).
- **Auth to verify**: needs a signed-in session to confirm behaviour.
- **Not verified**: no evidence either way.

| # | Feature | Reference evidence | Classification | ClipForge AI status |
| --- | --- | --- | --- | --- |
| 1 | Landing page + grouped navigation | Public page text | Observed, Reproducible | Built (original design) |
| 2 | Sign up / log in | Link targets `/signup`, `/dashboard` | Observed (links), Auth to verify | Built with Supabase Auth (+ local dev auth) |
| 3 | Prompt / script input | "Paste a post or write your own" | Observed, Reproducible, External (LLM) | Built: manual editor + LLM adapters |
| 4 | Templates / styles | "15+ viral" subtitle styles | Observed (count only), Auth to verify | Built: caption style presets + video templates |
| 5 | Caption customization | "restyle captions before you export" | Observed, Reproducible | Built: font, size, colors, highlight, stroke, shadow, position, word animation |
| 6 | Voiceover | "100+ high-quality AI voices" | Observed, External | Built: TTS adapter (espeak-ng free local, OpenAI-compatible optional) + upload |
| 7 | Media selection | Upload file or YouTube/TikTok link | Observed | Uploads built; stock search adapter (Pexels, optional). Link download **not built** (licensing/ToS risk) |
| 8 | Preview / editor | "Web-Based Editor", screenshot only | Observed (existence), Auth to verify, Not verified (controls) | Built: three-panel editor + timeline |
| 9 | Export | "ready-to-post" | Observed, Not verified (format) | Built: H.264/AAC 1080x1920 MP4 via Remotion worker |
| 10 | Pricing and usage limits | Plans, credits, export minutes | Observed | Usage accounting + demo quotas, no charging |
| 11 | Responsive behaviour | — | Not verified | Our UI is responsive by design |
| 12 | Auto Clip (AI moment detection) | Feature page | Observed, External | Not in MVP |
| 13 | Fake Texts template | Feature page | Observed, Reproducible | Not in MVP (template system allows it later) |
| 14 | Face swap, background remover, voice changer | Feature pages | Observed, External | Out of scope |
| 15 | Loading / error states | — | Not verified | Ours documented in `ui-specification.md` |
