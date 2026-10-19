import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProbeResult } from '@clipforge/server-core';
import { PermanentJobError } from '../utils/job-errors.js';

const execFileAsync = promisify(execFile);

/** Codecs Chromium and Remotion's compositor both handle without conversion. */
const WEB_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const WEB_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le']);
const WEB_VIDEO_CONTAINERS = ['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm'];

export class FfmpegService {
  constructor(private readonly ffmpegPath: string) {}

  private async run(args: string[], timeoutMs: number): Promise<void> {
    try {
      // Arguments are an array: user-controlled values are never interpreted by a shell.
      await execFileAsync(this.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? '';
      throw new PermanentJobError('media', 'A media file could not be converted.', `ffmpeg failed: ${stderr.slice(0, 500)}`);
    }
  }

  needsVideoTranscode(probe: ProbeResult): boolean {
    if (!probe.video) return false;
    const codec = probe.video.codec_name ?? '';
    const pixOk = !probe.video.pix_fmt || ['yuv420p', 'yuvj420p', 'yuv420p10le'].includes(probe.video.pix_fmt);
    const audioOk = !probe.audio || WEB_AUDIO_CODECS.has(probe.audio.codec_name ?? '');
    const [mp4Family, webmFamily] = WEB_VIDEO_CONTAINERS;
    const containerOk =
      (probe.formatName === mp4Family && ['h264', 'av1'].includes(codec)) ||
      (probe.formatName === webmFamily && ['vp8', 'vp9', 'av1'].includes(codec));
    return !WEB_VIDEO_CODECS.has(codec) || !pixOk || !audioOk || !containerOk;
  }

  needsAudioTranscode(probe: ProbeResult): boolean {
    return !probe.audio || !WEB_AUDIO_CODECS.has(probe.audio.codec_name ?? '');
  }

  /** Convert any accepted video to browser-friendly H.264/AAC MP4, capped at 1920px on the long side. */
  async toWebVideo(input: string, output: string, timeoutMs = 15 * 60_000): Promise<void> {
    await this.run(
      [
        '-i', input,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))',format=yuv420p",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
        '-movflags', '+faststart',
        output,
      ],
      timeoutMs,
    );
  }

  async toAac(input: string, output: string, timeoutMs = 5 * 60_000): Promise<void> {
    await this.run(['-i', input, '-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', output], timeoutMs);
  }

  /** Single JPEG frame for project thumbnails. */
  async thumbnail(input: string, output: string, atSeconds: number): Promise<void> {
    await this.run(['-ss', atSeconds.toFixed(2), '-i', input, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '4', output], 60_000);
  }
}
