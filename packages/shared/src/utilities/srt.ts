import type { CaptionSegment } from '../schemas/timeline.js';

export class SrtParseError extends Error {
  constructor(message: string, readonly block: number) {
    super(message);
    this.name = 'SrtParseError';
  }
}

const TIME = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/u;

export function parseSrtTimestamp(value: string): number {
  const m = TIME.exec(value.trim());
  if (!m) throw new Error(`Invalid SRT timestamp: ${value}`);
  const [, h, min, s, ms] = m;
  return Number(h) * 3_600_000 + Number(min) * 60_000 + Number(s) * 1000 + Number(ms!.padEnd(3, '0'));
}

export function formatSrtTimestamp(totalMs: number): string {
  const ms = Math.max(0, Math.round(totalMs));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(rest, 3)}`;
}

/** Parse SRT text into caption segments (timing source: imported). Strips simple HTML-like tags. */
export function parseSrt(input: string, newId: () => string): CaptionSegment[] {
  const text = input.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trim();
  if (!text) return [];
  const blocks = text.split(/\n{2,}/u);
  const segments: CaptionSegment[] = [];
  blocks.forEach((block, index) => {
    const lines = block.split('\n').map((l) => l.trim());
    let i = 0;
    if (/^\d+$/u.test(lines[0] ?? '')) i = 1;
    const timing = lines[i];
    if (!timing || !timing.includes('-->')) throw new SrtParseError(`Missing timing line in block ${index + 1}`, index + 1);
    const [startRaw, endRaw] = timing.split('-->');
    let startMs: number;
    let endMs: number;
    try {
      startMs = parseSrtTimestamp(startRaw ?? '');
      endMs = parseSrtTimestamp((endRaw ?? '').trim().split(/\s+/u)[0] ?? '');
    } catch (e) {
      throw new SrtParseError((e as Error).message, index + 1);
    }
    if (endMs <= startMs) throw new SrtParseError(`End time must be after start time in block ${index + 1}`, index + 1);
    const body = lines
      .slice(i + 1)
      .join(' ')
      .replace(/<[^>]*>/gu, '')
      .replace(/\{[^}]*\}/gu, '')
      .replace(/\s+/gu, ' ')
      .trim();
    if (!body) return;
    segments.push({ id: newId(), startMs, endMs, text: body.slice(0, 500), timingSource: 'imported' });
  });
  return segments.sort((a, b) => a.startMs - b.startMs);
}

export function serializeSrt(segments: readonly CaptionSegment[]): string {
  return (
    [...segments]
      .sort((a, b) => a.startMs - b.startMs)
      .map((s, i) => `${i + 1}\n${formatSrtTimestamp(s.startMs)} --> ${formatSrtTimestamp(s.endMs)}\n${s.text}\n`)
      .join('\n')
  );
}
