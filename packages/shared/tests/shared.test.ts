import { describe, expect, it } from 'vitest';
import {
  buildEstimatedCaptions,
  CaptionStyleSchema,
  durationInFrames,
  formatSrtTimestamp,
  isKeyword,
  moveVideoClip,
  parseSrt,
  parseSrtTimestamp,
  placeClips,
  ScriptSchema,
  serializeSrt,
  SrtParseError,
  timelineDurationMs,
  TimelineSchema,
  trimClip,
  wordsForSegment,
  wrapCaptionLines,
  type Clip,
} from '../src/index.js';

let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const clip = (over: Partial<Clip>): Clip => ({
  id: newId(),
  track: 'video',
  assetId: newId(),
  order: 0,
  startMs: 0,
  trimStartMs: 0,
  durationMs: 1000,
  volume: 1,
  fit: 'cover',
  loop: false,
  transition: 'none',
  transitionMs: 300,
  ...over,
});

describe('SRT', () => {
  it('round-trips timestamps', () => {
    expect(parseSrtTimestamp('01:02:03,045')).toBe(3_723_045);
    expect(formatSrtTimestamp(3_723_045)).toBe('01:02:03,045');
    expect(parseSrtTimestamp('00:00:01.5')).toBe(1500);
  });

  it('parses, strips tags and serializes', () => {
    const srt = '1\r\n00:00:00,000 --> 00:00:01,200\r\n<i>Hello</i> there\r\n\r\n2\r\n00:00:01,200 --> 00:00:02,000\r\nworld\r\n';
    const segs = parseSrt(srt, newId);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ startMs: 0, endMs: 1200, text: 'Hello there', timingSource: 'imported' });
    const out = serializeSrt(segs);
    expect(out).toContain('00:00:01,200 --> 00:00:02,000\nworld');
    expect(parseSrt(out, newId).map((s) => s.text)).toEqual(['Hello there', 'world']);
  });

  it('rejects broken blocks', () => {
    expect(() => parseSrt('1\nnot a time\nhi', newId)).toThrow(SrtParseError);
    expect(() => parseSrt('1\n00:00:02,000 --> 00:00:01,000\nhi', newId)).toThrow(/after start/u);
  });
});

describe('captions', () => {
  it('builds estimated segments that cover the narration duration', () => {
    const segs = buildEstimatedCaptions('one two three four five six seven', { totalDurationMs: 7000, newId });
    expect(segs).toHaveLength(2);
    expect(segs.every((s) => s.timingSource === 'estimated')).toBe(true);
    expect(segs[0]!.startMs).toBe(0);
    expect(segs.at(-1)!.endMs).toBe(7000);
    const words = segs.flatMap((s) => s.words ?? []);
    for (let i = 1; i < words.length; i++) expect(words[i]!.startMs).toBe(words[i - 1]!.endMs);
  });

  it('marks words estimated when the segment has no word timings', () => {
    const r = wordsForSegment({ id: newId(), startMs: 0, endMs: 1000, text: 'a b', timingSource: 'manual' });
    expect(r.estimated).toBe(true);
    expect(r.words).toHaveLength(2);
  });

  it('wraps lines on word boundaries', () => {
    expect(wrapCaptionLines('the quick brown fox jumps', 10)).toEqual(['the quick', 'brown fox', 'jumps']);
    expect(wrapCaptionLines('supercalifragilistic word', 5)).toEqual(['supercalifragilistic', 'word']);
  });

  it('matches keywords ignoring case and punctuation', () => {
    expect(isKeyword('Money!', ['money'])).toBe(true);
    expect(isKeyword('mon', ['money'])).toBe(false);
  });

  it('applies style defaults', () => {
    expect(CaptionStyleSchema.parse({})).toMatchObject({ position: 'center', animation: 'karaoke' });
  });
});

describe('timeline', () => {
  it('places video clips back to back and audio by start', () => {
    const a = clip({ order: 1, durationMs: 2000 });
    const b = clip({ order: 0, durationMs: 1500 });
    const music = clip({ track: 'music', startMs: 500, durationMs: 5000 });
    const placed = placeClips([a, b, music]);
    expect(placed.find((p) => p.id === b.id)).toMatchObject({ timelineStartMs: 0, timelineEndMs: 1500 });
    expect(placed.find((p) => p.id === a.id)).toMatchObject({ timelineStartMs: 1500, timelineEndMs: 3500 });
    expect(timelineDurationMs({ clips: [a, b, music], captions: [] })).toBe(5500);
    expect(durationInFrames({ clips: [a, b, music], captions: [] }, 30)).toBe(165);
  });

  it('has a one second minimum duration', () => {
    expect(timelineDurationMs({ clips: [], captions: [] })).toBe(1000);
  });

  it('reorders and trims clips', () => {
    const a = clip({ order: 0 });
    const b = clip({ order: 1 });
    const moved = moveVideoClip([a, b], b.id, -1);
    expect(moved.find((c) => c.id === b.id)!.order).toBe(0);
    const t = trimClip(clip({ durationMs: 5000 }), { trimStartMs: 4000, durationMs: 5000 }, 6000);
    expect(t).toMatchObject({ trimStartMs: 4000, durationMs: 2000 });
  });

  it('validates a full timeline and rejects bad captions', () => {
    const ok = TimelineSchema.safeParse({ clips: [clip({})], captions: [], captionStyle: {} });
    expect(ok.success).toBe(true);
    const bad = TimelineSchema.safeParse({
      clips: [],
      captions: [{ id: newId(), startMs: 500, endMs: 100, text: 'x' }],
      captionStyle: {},
    });
    expect(bad.success).toBe(false);
  });

  it('validates scripts', () => {
    expect(ScriptSchema.safeParse({ hook: 'Hi', segments: [], estimatedDurationSec: 5 }).success).toBe(false);
    expect(ScriptSchema.safeParse({ hook: 'Hi', segments: [{ narration: 'x' }], estimatedDurationSec: 5 }).success).toBe(true);
  });
});
