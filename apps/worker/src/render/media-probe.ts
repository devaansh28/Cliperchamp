import { stat } from 'node:fs/promises';
import { parseFrameRate, probeMedia, type ProbeResult } from '@clipforge/server-core';
import type { OutputProfile } from '@clipforge/shared';
import { PermanentJobError } from '../utils/job-errors.js';

export interface MediaLimits {
  maxDurationMs: number;
  maxDimension: number;
}

/** Validate a source file against its declared kind and our limits. */
export async function inspectSource(ffprobePath: string, file: string, kind: 'video' | 'image' | 'audio', limits: MediaLimits): Promise<ProbeResult> {
  const probe = await probeMedia(ffprobePath, file);
  if (kind === 'video' && !probe.video) throw new PermanentJobError('media', 'The video file has no video track.');
  if (kind === 'audio' && !probe.audio) throw new PermanentJobError('media', 'The audio file has no audio track.');
  if (kind === 'image' && !probe.video) throw new PermanentJobError('media', 'The image could not be decoded.');
  if (kind !== 'image' && probe.durationMs !== null && probe.durationMs > limits.maxDurationMs) {
    throw new PermanentJobError('validation', `Media longer than ${Math.round(limits.maxDurationMs / 60000)} minutes is not supported.`);
  }
  if (probe.video && ((probe.video.width ?? 0) > limits.maxDimension || (probe.video.height ?? 0) > limits.maxDimension)) {
    throw new PermanentJobError('validation', `Media larger than ${limits.maxDimension}px is not supported.`);
  }
  return probe;
}

export interface OutputCheck {
  ok: boolean;
  problems: string[];
  durationMs: number | null;
  sizeBytes: number;
  probe: ProbeResult;
}

/** Verify the rendered MP4 matches the requested profile. */
export async function validateOutput(
  ffprobePath: string,
  file: string,
  expected: { profile: OutputProfile; durationMs: number; expectAudio: boolean; maxSizeBytes: number },
): Promise<OutputCheck> {
  const probe = await probeMedia(ffprobePath, file);
  const sizeBytes = (await stat(file)).size;
  const problems: string[] = [];
  const v = probe.video;
  if (!probe.formatName.includes('mp4')) problems.push(`container ${probe.formatName}`);
  if (!v) problems.push('no video stream');
  else {
    if (v.codec_name !== 'h264') problems.push(`video codec ${v.codec_name}`);
    if (v.width !== expected.profile.width || v.height !== expected.profile.height) problems.push(`dimensions ${v.width}x${v.height}`);
    if (v.pix_fmt !== expected.profile.pixelFormat) problems.push(`pixel format ${v.pix_fmt}`);
    const fps = parseFrameRate(v.avg_frame_rate) ?? parseFrameRate(v.r_frame_rate);
    if (!fps || Math.abs(fps - expected.profile.fps) > 0.5) problems.push(`frame rate ${fps}`);
  }
  if (expected.expectAudio) {
    if (!probe.audio) problems.push('no audio stream');
    else if (probe.audio.codec_name !== 'aac') problems.push(`audio codec ${probe.audio.codec_name}`);
  }
  const tolerance = Math.max(150, (1000 / expected.profile.fps) * 2);
  if (probe.durationMs === null || Math.abs(probe.durationMs - expected.durationMs) > tolerance + 100) {
    problems.push(`duration ${probe.durationMs}ms (expected ${expected.durationMs}ms)`);
  }
  if (sizeBytes <= 0 || sizeBytes > expected.maxSizeBytes) problems.push(`size ${sizeBytes} bytes`);
  return { ok: problems.length === 0, problems, durationMs: probe.durationMs, sizeBytes, probe };
}
