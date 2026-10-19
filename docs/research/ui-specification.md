# UI specification (ClipForge AI)

Original design informed by the research. Nothing here is copied from the
reference's markup, styles or assets; the reference's signed-in UI was not
observed (see `evidence-and-limitations.md`).

## Brand

- Name: **ClipForge AI**. Mark: a lightning-cut "C" drawn with Lucide's `Clapperboard`.
- Palette: near-black ink background `#0b0b10`, surface `#15151d`, accent
  "forge orange" `#ff6a2b`, secondary violet `#8b5cf6`, success `#22c55e`.
- Type: Inter (UI), bold condensed caption fonts for video presets.

## Public pages

- **Landing**: hero with headline, sub-copy and two CTAs; three-step "How it
  works"; feature grid (Script, Voice, Captions, Render); pricing teaser that
  says plainly the MVP is free with demo quotas; footer.
- **Login / Register**: centered card, React Hook Form + Zod validation,
  inline errors, disabled button while submitting.

## App shell (signed in)

Left sidebar on desktop (Dashboard, Projects, Settings, Usage), top bar with a
menu button on mobile (< 768px).

- **Dashboard**: "New video" CTA, recent projects, usage summary.
- **Projects**: search box, sort (updated / name / created), cards with
  rename, duplicate, delete (confirm dialog).
- **Create project**: name + template picker → creates and opens the editor.
- **Settings**: display name, password change link, sign out, provider status
  (which integrations are configured).
- **Billing / Usage**: usage bars against demo limits; no payment.

## Editor (three panels + timeline)

- **Left tabs**: Script, Media, Voice, Captions, Music, Templates.
- **Center**: 9:16 preview (Remotion Player using the shared composition),
  play/pause, current time / total, fit-to-panel scaling, fullscreen.
- **Right**: inspector for the selection: caption typography, colors,
  highlight color, position, stroke/shadow, clip volume, media fit, transition.
- **Bottom timeline**: tracks for video, narration, music and captions;
  playhead; select, reorder (move left/right), trim (start/end inputs and
  handles), delete.
- **Top bar**: project name (rename inline), save status ("Saved", "Saving…",
  "Unsaved changes", "Save failed"), undo/redo, Render button.
- **Render panel**: job list with real states (queued, processing, completed,
  failed, cancelled), real progress when the worker reports it, otherwise an
  indeterminate bar; Download for completed jobs.

## States

- Loading: skeletons for lists, spinners on buttons.
- Empty: illustrated hint + primary action.
- Errors: safe message from the API, retry where it makes sense.
- Missing integration: amber banner naming the variable to set; the manual
  path stays available.
