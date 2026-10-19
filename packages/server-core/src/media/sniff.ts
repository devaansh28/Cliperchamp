import { open } from 'node:fs/promises';
import { ALLOWED_UPLOAD_MIME, type MediaKind } from '@clipforge/shared';

/**
 * Identify a file from its leading bytes (not the client's declared type or extension).
 * Only formats we accept are recognised; everything else returns null.
 */
export async function sniffMedia(filePath: string): Promise<{ mime: string; kind: MediaKind; ext: string } | null> {
  const fh = await open(filePath, 'r');
  const buf = Buffer.alloc(64);
  try {
    await fh.read(buf, 0, 64, 0);
  } finally {
    await fh.close();
  }
  return sniffBuffer(buf);
}

export function sniffBuffer(b: Buffer): { mime: string; kind: MediaKind; ext: string } | null {
  const ascii = (start: number, end: number) => b.subarray(start, end).toString('latin1');
  // ISO BMFF (mp4 / mov / m4a): "ftyp" at offset 4
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'qt  ') return { mime: 'video/quicktime', kind: 'video', ext: 'mov' };
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) return { mime: 'audio/mp4', kind: 'audio', ext: 'm4a' };
    return { mime: 'video/mp4', kind: 'video', ext: 'mp4' };
  }
  // Matroska / WebM (EBML header)
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return ascii(0, 64).includes('webm')
      ? { mime: 'video/webm', kind: 'video', ext: 'webm' }
      : { mime: 'video/x-matroska', kind: 'video', ext: 'mkv' };
  }
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return { mime: 'image/png', kind: 'image', ext: 'png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', kind: 'image', ext: 'jpg' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mime: 'image/webp', kind: 'image', ext: 'webp' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { mime: 'audio/wav', kind: 'audio', ext: 'wav' };
  if (ascii(0, 4) === 'OggS') return { mime: 'audio/ogg', kind: 'audio', ext: 'ogg' };
  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0 && ((b[1] ?? 0) & 0x06) !== 0)) {
    return { mime: 'audio/mpeg', kind: 'audio', ext: 'mp3' };
  }
  if (b[0] === 0xff && ((b[1] ?? 0) & 0xf6) === 0xf0) return { mime: 'audio/aac', kind: 'audio', ext: 'aac' };
  return null;
}

export function isAllowedMime(mime: string): boolean {
  return Object.values(ALLOWED_UPLOAD_MIME).some((list) => (list as readonly string[]).includes(mime));
}
