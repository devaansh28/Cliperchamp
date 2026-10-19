# User flows

"Reference" columns come from public page text only (not REA, not a signed-in
session). "ClipForge AI" columns describe our own implementation.

## 1. Discover → sign up

| Step | Reference (observed) | ClipForge AI |
| --- | --- | --- |
| Land on homepage | Hero + "Try Crayo Now" | Landing page with "Start creating" |
| Click CTA | Goes to `/signup` (link target) | `/register` |
| Sign up | Not verified (auth required) | Email + password via Supabase Auth |
| After sign-up | Not verified | Redirect to `/app` dashboard |

Loading/error states: not verified for the reference. Ours: inline form errors,
disabled submit while pending, toast on server error.

## 2. Create a story video (our core flow, modeled on "Reddit Story")

1. Dashboard → "New video" → name the project (state: project row created).
2. Script step: enter topic, audience, language, tone, target duration,
   objective, optional source script → "Generate" (calls the configured LLM) or
   "Write manually". Output: hook, segments, scene descriptions, CTA, estimated
   duration. Loading: spinner on button. Error: provider message; if no provider
   is configured, an explicit banner and the manual editor.
3. Media step: upload background video/image (validated by MIME sniffing and
   FFprobe), or search the stock provider when configured.
4. Voice step: pick voice + speed → "Generate voiceover" (TTS job) or upload narration.
5. Captions: auto-built from script segments with **estimated** timing, or SRT
   import; edit text/timestamps; choose a style preset.
6. Editor: live preview using the same Remotion composition as the renderer.
7. Export: "Render MP4" → job is queued → status polled → download button
   with a signed URL when completed.

Reference evidence: the Reddit Story page says users "Paste a post or write
your own" and get "an AI voiceover and captions". Intermediate screens are
**not verified**.

## 3. Return later

Reference: not verified. Ours: Projects page lists projects (search, sort);
opening one restores script, timeline, captions and render history from the database.

## 4. Usage and limits

Reference: usage shown "in settings via the profile picture in the top right"
(FAQ text). Ours: Billing page shows usage against demo quotas; actions over
quota return a clear 402-style message (no charging).
