import { normalizeOrders, timelineDurationMs, type CaptionSegment, type Clip, type Timeline } from '@clipforge/shared';
import type { MediaAssetWithUrl } from '@/lib/api';

export const DEFAULT_IMAGE_MS = 3000;

export function newId(): string {
  return crypto.randomUUID();
}

/** Build a clip for an asset on the given track with sensible defaults. */
export function clipForAsset(timeline: Timeline, asset: MediaAssetWithUrl, track: Clip['track']): Clip {
  const videoClips = timeline.clips.filter((c) => c.track === 'video');
  const nextOrder = videoClips.length ? Math.max(...videoClips.map((c) => c.order)) + 1 : 0;
  const source = asset.durationMs;
  const base = {
    id: newId(),
    assetId: asset.id,
    trimStartMs: 0,
    fit: 'cover' as const,
    transition: 'none' as const,
    transitionMs: 300,
  };
  if (track === 'video') {
    return { ...base, track, order: nextOrder, startMs: 0, durationMs: asset.kind === 'image' ? DEFAULT_IMAGE_MS : Math.max(100, source ?? DEFAULT_IMAGE_MS), volume: 0, loop: false };
  }
  if (track === 'music') {
    // Music loops under the whole video.
    const total = timelineDurationMs(timeline);
    return { ...base, track, order: 0, startMs: 0, durationMs: Math.max(1000, total), volume: 0.25, loop: true };
  }
  return { ...base, track, order: 0, startMs: 0, durationMs: Math.max(100, source ?? 1000), volume: 1, loop: false };
}

export function addClip(timeline: Timeline, clip: Clip): Timeline {
  // Only one narration and one music clip at a time keeps the mix predictable.
  const others = clip.track === 'video' ? timeline.clips : timeline.clips.filter((c) => c.track !== clip.track);
  return { ...timeline, clips: normalizeOrders([...others, clip]) };
}

export function removeClip(timeline: Timeline, clipId: string): Timeline {
  return { ...timeline, clips: normalizeOrders(timeline.clips.filter((c) => c.id !== clipId)) };
}

export function patchClip(timeline: Timeline, clipId: string, patch: Partial<Clip>): Timeline {
  return { ...timeline, clips: timeline.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) };
}

/** Move a video clip to a new index in the video track. */
export function reorderVideoClip(timeline: Timeline, clipId: string, toIndex: number): Timeline {
  const video = timeline.clips.filter((c) => c.track === 'video').sort((a, b) => a.order - b.order);
  const from = video.findIndex((c) => c.id === clipId);
  if (from < 0) return timeline;
  const [moved] = video.splice(from, 1);
  video.splice(Math.max(0, Math.min(toIndex, video.length)), 0, moved!);
  const order = new Map(video.map((c, i) => [c.id, i]));
  return { ...timeline, clips: timeline.clips.map((c) => (c.track === 'video' ? { ...c, order: order.get(c.id)! } : c)) };
}

export function setCaptions(timeline: Timeline, captions: CaptionSegment[]): Timeline {
  return { ...timeline, captions: [...captions].sort((a, b) => a.startMs - b.startMs) };
}

export function patchCaption(timeline: Timeline, id: string, patch: Partial<CaptionSegment>): Timeline {
  return setCaptions(
    timeline,
    timeline.captions.map((c) => {
      if (c.id !== id) return c;
      const next = { ...c, ...patch };
      // Word timings no longer match after the text or timing changes by hand.
      if (patch.text !== undefined || patch.startMs !== undefined || patch.endMs !== undefined) {
        delete next.words;
        next.timingSource = 'manual';
      }
      return next;
    }),
  );
}

export function removeCaption(timeline: Timeline, id: string): Timeline {
  return { ...timeline, captions: timeline.captions.filter((c) => c.id !== id) };
}

/** Insert a caption at `atMs`, 2 s long, not overlapping the next one. */
export function insertCaption(timeline: Timeline, atMs: number, text = 'New caption'): { timeline: Timeline; id: string } {
  const start = Math.max(0, Math.round(atMs));
  const next = timeline.captions.find((c) => c.startMs > start);
  const end = Math.max(start + 300, Math.min(start + 2000, next ? next.startMs : start + 2000));
  const id = newId();
  return { id, timeline: setCaptions(timeline, [...timeline.captions, { id, startMs: start, endMs: end, text, timingSource: 'manual' }]) };
}
