import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
};

/**
 * Loopback-only HTTP server that exposes staged job files to the Remotion renderer.
 * Each job registers its directory under a random token; only plain filenames inside
 * that directory are served, so nothing else on disk is reachable.
 */
export class AssetServer {
  private readonly dirs = new Map<string, string>();
  private server: http.Server | null = null;
  private port = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  register(dir: string): { token: string; urlFor: (filename: string) => string } {
    const token = randomBytes(18).toString('base64url');
    this.dirs.set(token, path.resolve(dir));
    return { token, urlFor: (filename) => `http://127.0.0.1:${this.port}/${token}/${encodeURIComponent(filename)}` };
  }

  unregister(token: string): void {
    this.dirs.delete(token);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    const [, token, name, ...rest] = (req.url ?? '').split('?')[0]!.split('/');
    const dir = token ? this.dirs.get(token) : undefined;
    const filename = name ? decodeURIComponent(name) : '';
    if (!dir || rest.length > 0 || !/^[\w.-]+$/u.test(filename) || filename.startsWith('.')) return void res.writeHead(404).end();
    const file = path.join(dir, filename);
    let size: number;
    try {
      const s = await stat(file);
      if (!s.isFile()) throw new Error('not a file');
      size = s.size;
    } catch {
      return void res.writeHead(404).end();
    }
    const type = MIME[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/u.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : size - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start < 0 || start > end || start >= size) return void res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' });
      if (req.method === 'HEAD') return void res.end();
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file).pipe(res);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
