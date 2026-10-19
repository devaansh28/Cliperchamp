import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CaptionWord } from '@clipforge/shared';
import { fetchWithTimeout, isTransientStatus, ProviderError, ProviderNotConfiguredError } from '../errors.js';

export interface AlignmentProvider {
  readonly provider: string;
  readonly configured: boolean;
  /** Transcribe audio and return word timings measured from the audio. */
  transcribeWords(audioPath: string): Promise<CaptionWord[]>;
}

export class NoAlignment implements AlignmentProvider {
  readonly provider = 'none';
  readonly configured = false;
  async transcribeWords(): Promise<CaptionWord[]> {
    throw new ProviderNotConfiguredError(
      'alignment',
      'Set ALIGN_PROVIDER=openai-compatible (a Whisper-style transcription endpoint) for audio-synced word timings. Captions use estimated timing until then.',
    );
  }
}

/** Whisper-compatible /audio/transcriptions with word timestamps. */
export class OpenAICompatibleAlignment implements AlignmentProvider {
  readonly provider = 'openai-compatible';
  readonly configured = true;
  constructor(private readonly baseUrl: string, private readonly apiKey: string | undefined, private readonly model: string) {}

  async transcribeWords(audioPath: string): Promise<CaptionWord[]> {
    const form = new FormData();
    form.set('file', new Blob([await readFile(audioPath)]), path.basename(audioPath));
    form.set('model', this.model);
    form.set('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    const res = await fetchWithTimeout(
      `${this.baseUrl.replace(/\/$/u, '')}/audio/transcriptions`,
      { method: 'POST', body: form, headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {} },
      180_000,
    );
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}`, isTransientStatus(res.status), 'Caption alignment failed.');
    const body = (await res.json()) as { words?: { word: string; start: number; end: number }[] };
    if (!body.words?.length) throw new ProviderError('No word timestamps', false, 'The transcription service returned no word timings.');
    return body.words
      .filter((w) => w.word.trim())
      .map((w) => ({
        text: w.word.trim().slice(0, 64),
        startMs: Math.round(w.start * 1000),
        endMs: Math.max(Math.round(w.end * 1000), Math.round(w.start * 1000) + 1),
      }));
  }
}

export function createAlignmentProvider(env: {
  ALIGN_PROVIDER: 'none' | 'openai-compatible';
  ALIGN_API_KEY?: string;
  ALIGN_MODEL?: string;
  ALIGN_BASE_URL?: string;
}): AlignmentProvider {
  return env.ALIGN_PROVIDER === 'openai-compatible'
    ? new OpenAICompatibleAlignment(env.ALIGN_BASE_URL!, env.ALIGN_API_KEY, env.ALIGN_MODEL!)
    : new NoAlignment();
}
