# Site analysis: crayo.ai (public pages)

Evidence source for every item: public page text fetched 2026-10-19 (see
`evidence-and-limitations.md`). Implementation details are **inferred** unless
stated otherwise; no REA capture was possible.

## Positioning

- Hero: "The #1 Clipping Tool" / "Edit Viral Videos With AI", with "Your
  all-in-one platform for editing." Social proof "3.2M+ users worldwide".
- Core promise: auto clipping, AI voiceovers, styled subtitles, story videos.
- Primary CTA "Try Crayo Now" goes to `/signup`; secondary CTAs go to `/dashboard`.

## Landing page structure (top to bottom)

1. Navigation with grouped menus: Generate Videos, AI Tools, Editing Tools,
   Use Cases, Free Tools, Calculators, Learn, Product, Legal.
2. Hero with CTA and user-count badge.
3. "3 Step Workflow": upload a video (file or YouTube/TikTok link) → choose one
   of "15+ viral" subtitle styles → generate.
4. "Web-Based Editor" section with an editor screenshot (alt text only "Editor Demo").
5. "Countless Tools" grid: AI Images, AI Voiceovers, AI Videos, social video
   download, background remover, idea brainstorm, speech enhancer.
6. Testimonials and a co-founder quote.
7. FAQ (credits, export minutes, refunds, languages, rights, support).
8. Large footer link directory.

## Video workflows advertised

| Workflow | Input | Output | Notes |
| --- | --- | --- | --- |
| Reddit Story | Pasted post or own text | Narrated, captioned vertical video | Background/gameplay options not described publicly |
| Fake Texts | Conversation written by user or AI | Message-by-message chat video with voices | Visual themes not described publicly |
| Auto Clip | Long video upload (podcast, stream, webinar) | Scored short clips with captions | Editor allows trim, reframe, restyle captions |
| AI Voiceover | Script text | Narration audio, "100+ voices" | Speed/preview/format not described |

## Pricing model (public page text)

Three paid plans, no free tier listed: Hobby ($13/mo), Clipper ($27/mo),
Pro ($55/mo). Usage is metered in **workflow credits** (one AI-generated video
each), **export minutes** (total generated video length), voiceover minutes,
AI images and storage. Credits reset each cycle; top-ups are separate; no refunds.

## Takeaways for ClipForge AI

- The unit of work is a **project** that becomes one vertical video.
- The minimum loop users expect: text in → script → voice → captions →
  background media → preview → export.
- Caption styling is a headline feature (named presets).
- Usage is metered per generation and per exported minute, which maps directly
  onto our `usage_events` table and quotas.
