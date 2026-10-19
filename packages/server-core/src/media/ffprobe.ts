import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProbeStream {
  codec_type: 'video' | 'audio' | string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
}

export interface ProbeResult {
  formatName: string;
  durationMs: number | null;
  sizeBytes: number | null;
  video: ProbeStream | null;
  audio: ProbeStream | null;
  streams: ProbeStream[];
}

export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeError';
  }
}

/** Inspect a local media file with ffprobe. Arguments are passed as an array (no shell). */
export async function probeMedia(ffprobePath: string, filePath: string, timeoutMs = 30_000): Promise<ProbeResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '--', filePath],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
    ));
  } catch {
    throw new ProbeError('The file could not be read as media');
  }
  let json: { format?: { format_name?: string; duration?: string; size?: string }; streams?: ProbeStream[] };
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new ProbeError('Unexpected ffprobe output');
  }
  const streams = json.streams ?? [];
  const duration = Number(json.format?.duration);
  return {
    formatName: json.format?.format_name ?? 'unknown',
    durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : null,
    sizeBytes: json.format?.size ? Number(json.format.size) : null,
    video: streams.find((s) => s.codec_type === 'video') ?? null,
    audio: streams.find((s) => s.codec_type === 'audio') ?? null,
    streams,
  };
}

export function parseFrameRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split('/').map(Number);
  if (!n || !d) return null;
  return n / d;
}
