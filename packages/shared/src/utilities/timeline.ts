import type { CaptionSegment, Clip, Timeline } from '../schemas/timeline.js';

export interface PlacedClip extends Clip {
  /** Absolute start on the timeline in ms. */
  timelineStartMs: number;
  timelineEndMs: number;
}

/** Video clips play back to back by `order`; audio clips keep their own `startMs`. */
export function placeClips(clips: readonly Clip[]): PlacedClip[] {
  const video = clips.filter((c) => c.track === 'video').sort((a, b) => a.order - b.order);
  const placed: PlacedClip[] = [];
  let cursor = 0;
  for (const clip of video) {
    placed.push({ ...clip, timelineStartMs: cursor, timelineEndMs: cursor + clip.durationMs });
    cursor += clip.durationMs;
  }
  for (const clip of clips) {
    if (clip.track === 'video') continue;
    placed.push({ ...clip, timelineStartMs: clip.startMs, timelineEndMs: clip.startMs + clip.durationMs });
  }
  return placed;
}

export function videoTrackDurationMs(clips: readonly Clip[]): number {
  return clips.filter((c) => c.track === 'video').reduce((sum, c) => sum + c.durationMs, 0);
}

/** Total duration: the longest of video track, audio clips and captions. Minimum one second. */
export function timelineDurationMs(timeline: Pick<Timeline, 'clips' | 'captions'>): number {
  let end = videoTrackDurationMs(timeline.clips);
  for (const c of timeline.clips) if (c.track !== 'video') end = Math.max(end, c.startMs + c.durationMs);
  for (const s of timeline.captions) end = Math.max(end, s.endMs);
  return Math.max(end, 1000);
}

export function msToFrames(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

export function durationInFrames(timeline: Pick<Timeline, 'clips' | 'captions'>, fps: number): number {
  return Math.max(1, msToFrames(timelineDurationMs(timeline), fps));
}

/** Re-number video clip orders to 0..n-1 keeping their relative order. */
export function normalizeOrders(clips: readonly Clip[]): Clip[] {
  const video = clips.filter((c) => c.track === 'video').sort((a, b) => a.order - b.order);
  const orderById = new Map(video.map((c, i) => [c.id, i] as const));
  return clips.map((c) => (c.track === 'video' ? { ...c, order: orderById.get(c.id) ?? 0 } : c));
}

export function moveVideoClip(clips: readonly Clip[], clipId: string, direction: -1 | 1): Clip[] {
  const normalized = normalizeOrders(clips);
  const target = normalized.find((c) => c.id === clipId);
  if (!target || target.track !== 'video') return normalized;
  const swapWith = normalized.find((c) => c.track === 'video' && c.order === target.order + direction);
  if (!swapWith) return normalized;
  return normalized.map((c) => {
    if (c.id === target.id) return { ...c, order: swapWith.order };
    if (c.id === swapWith.id) return { ...c, order: target.order };
    return c;
  });
}

/**
 * Trim a clip. `sourceDurationMs` (if known) bounds the trim for non-looping clips.
 */
export function trimClip(
  clip: Clip,
  patch: { trimStartMs?: number; durationMs?: number },
  sourceDurationMs: number | null,
): Clip {
  const trimStartMs = Math.max(0, Math.round(patch.trimStartMs ?? clip.trimStartMs));
  let durationMs = Math.max(100, Math.round(patch.durationMs ?? clip.durationMs));
  if (sourceDurationMs !== null && !clip.loop) {
    const maxStart = Math.max(0, sourceDurationMs - 100);
    const start = Math.min(trimStartMs, maxStart);
    durationMs = Math.min(durationMs, sourceDurationMs - start);
    return { ...clip, trimStartMs: start, durationMs };
  }
  return { ...clip, trimStartMs, durationMs };
}

export function activeCaptionAt(captions: readonly CaptionSegment[], ms: number): CaptionSegment | undefined {
  return captions.find((c) => ms >= c.startMs && ms < c.endMs);
}
