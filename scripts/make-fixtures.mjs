#!/usr/bin/env node
// Generates deterministic, license-free test media with FFmpeg (no downloads).
//   node scripts/make-fixtures.mjs [outDir]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'fixtures/generated'));
mkdirSync(out, { recursive: true });
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';

function run(args) {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

const files = {
  // 4 s portrait test pattern with a 440 Hz tone, H.264/AAC.
  'background.mp4': [
    '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-shortest',
  ],
  // Landscape MPEG-4 Part 2 in MKV: exercises normalization to H.264.
  'landscape.mkv': [
    '-f', 'lavfi', '-i', 'mandelbrot=size=640x360:rate=25', '-t', '3',
    '-c:v', 'mpeg4', '-q:v', '5',
  ],
  // Narration stand-in: 3 s tone sweep (WAV).
  'narration.wav': ['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:duration=3', '-c:a', 'pcm_s16le'],
  // Music bed: 6 s MP3.
  'music.mp3': ['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=6', '-c:a', 'libmp3lame', '-b:a', '96k'],
  'still.png': ['-f', 'lavfi', '-i', 'color=c=0x8b5cf6:size=1080x1920:duration=1', '-frames:v', '1'],
};

for (const [name, args] of Object.entries(files)) {
  const target = path.join(out, name);
  if (existsSync(target) && !process.argv.includes('--force')) continue;
  run([...args, target]);
}
// A file with a video extension but text content, for upload-validation tests.
import('node:fs').then((fs) => fs.writeFileSync(path.join(out, 'fake.mp4'), 'this is not a video'));
console.log(`fixtures in ${out}`);
