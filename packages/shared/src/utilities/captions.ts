import type { CaptionSegment, CaptionWord, TimingSource } from '../schemas/timeline.js';

/** Average narration speed used when no audio duration is known. */
export const ESTIMATED_WORDS_PER_MINUTE = 150;

export function splitWords(text: string): string[] {
  return text.split(/\s+/u).map((w) => w.trim()).filter(Boolean);
}

export function estimateSpeechDurationMs(text: string, wordsPerMinute = ESTIMATED_WORDS_PER_MINUTE): number {
  const words = splitWords(text).length;
  return Math.max(500, Math.round((words / wordsPerMinute) * 60_000));
}

/** Weight words by letters plus a small constant so short words still get time. */
function wordWeight(word: string): number {
  return word.replace(/[^\p{L}\p{N}]/gu, '').length + 2;
}

/**
 * Spread words over [startMs, endMs] proportionally to their length.
 * This is an ESTIMATE. It is not speech alignment.
 */
export function estimateWordTimings(text: string, startMs: number, endMs: number): CaptionWord[] {
  const words = splitWords(text);
  if (words.length === 0) return [];
  const total = words.reduce((s, w) => s + wordWeight(w), 0);
  const span = Math.max(1, endMs - startMs);
  let cursor = startMs;
  return words.map((w, i) => {
    const len = i === words.length - 1 ? endMs - cursor : Math.round((wordWeight(w) / total) * span);
    const word = { text: w.slice(0, 64), startMs: cursor, endMs: Math.max(cursor + 1, cursor + len) };
    cursor = word.endMs;
    return word;
  });
}

export interface BuildCaptionsOptions {
  /** Narration duration if known (e.g. measured from audio). Otherwise estimated from word count. */
  totalDurationMs?: number;
  startMs?: number;
  maxWordsPerSegment?: number;
  newId: () => string;
}

/**
 * Turn narration text into caption segments with estimated word timings.
 * Timing source is always 'estimated': this never claims audio alignment.
 */
export function buildEstimatedCaptions(text: string, opts: BuildCaptionsOptions): CaptionSegment[] {
  const words = splitWords(text);
  if (words.length === 0) return [];
  const maxWords = opts.maxWordsPerSegment ?? 4;
  const start = opts.startMs ?? 0;
  const total = opts.totalDurationMs ?? estimateSpeechDurationMs(text);
  const allTimings = estimateWordTimings(text, start, start + total);
  const segments: CaptionSegment[] = [];
  for (let i = 0; i < allTimings.length; i += maxWords) {
    const chunk = allTimings.slice(i, i + maxWords);
    const first = chunk[0]!;
    const last = chunk[chunk.length - 1]!;
    segments.push({
      id: opts.newId(),
      startMs: first.startMs,
      endMs: last.endMs,
      text: chunk.map((w) => w.text).join(' '),
      words: chunk,
      timingSource: 'estimated',
    });
  }
  return segments;
}

/** Words for rendering: real timings if present, else estimated across the segment. */
export function wordsForSegment(segment: CaptionSegment): { words: CaptionWord[]; estimated: boolean } {
  const textWords = splitWords(segment.text);
  if (segment.words && segment.words.length === textWords.length && segment.words.length > 0) {
    return { words: segment.words, estimated: segment.timingSource === 'estimated' };
  }
  return { words: estimateWordTimings(segment.text, segment.startMs, segment.endMs), estimated: true };
}

/** Greedy line wrapping on word boundaries. Words longer than the limit stay on their own line. */
export function wrapCaptionLines(text: string, maxCharsPerLine: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of splitWords(text)) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= maxCharsPerLine) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function normalizeKeyword(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function isKeyword(word: string, keywords: readonly string[]): boolean {
  const w = normalizeKeyword(word);
  return w.length > 0 && keywords.some((k) => normalizeKeyword(k) === w);
}

export function retimeSegment(segment: CaptionSegment, startMs: number, endMs: number, source: TimingSource): CaptionSegment {
  return { ...segment, startMs, endMs, words: undefined, timingSource: source };
}
