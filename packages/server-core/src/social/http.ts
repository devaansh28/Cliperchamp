import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { SocialAuthError, SocialPlatformError } from './types.js';

export const API_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 30 * 60_000;

export function isTransient(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** fetch with a timeout; network failures become transient platform errors. */
export async function request(url: string, init: RequestInit & { timeoutMs?: number }, label: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? API_TIMEOUT_MS) });
  } catch (err) {
    throw new SocialPlatformError(`${label}: ${(err as Error).name}`, true, `${label} could not be reached. We'll try again.`);
  }
}

export async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    return { raw: text.slice(0, 300) } as T;
  }
}

/** Map an unsuccessful response to the right error class. */
export function failure(label: string, res: Response, detail: string): Error {
  if (res.status === 401) return new SocialAuthError(`${label} HTTP 401: ${detail}`);
  return new SocialPlatformError(`${label} HTTP ${res.status}: ${detail}`, isTransient(res.status), `${label} rejected the request (${res.status}).`);
}

/** Streams part of a file as a request body. */
export function fileBody(path: string, start?: number, end?: number): { body: ReadableStream; duplex: 'half' } {
  const stream = createReadStream(path, start === undefined ? undefined : { start, end });
  return { body: Readable.toWeb(stream) as ReadableStream, duplex: 'half' };
}

export function form(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Strip control characters and trim to a platform limit. */
export function clean(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').trim().slice(0, max);
}
