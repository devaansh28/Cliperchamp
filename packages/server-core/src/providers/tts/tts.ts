import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fetchWithTimeout, isTransientStatus, ProviderError, ProviderNotConfiguredError } from '../errors.js';

const execFileAsync = promisify(execFile);

export interface Voice {
  id: string;
  label: string;
}

export interface SynthesisResult {
  /** File extension of the produced audio (without dot). */
  ext: 'wav' | 'mp3';
  mimeType: string;
}

export interface TtsProvider {
  readonly provider: string;
  readonly configured: boolean;
  voices(): Voice[];
  /** Write narration audio to `destPath` (extension supplied by the caller from `outputExt`). */
  synthesize(text: string, voiceId: string, speed: number, destPath: string): Promise<SynthesisResult>;
  readonly outputExt: 'wav' | 'mp3';
}

export class NoTts implements TtsProvider {
  readonly provider = 'none';
  readonly configured = false;
  readonly outputExt = 'wav' as const;
  voices(): Voice[] {
    return [];
  }
  async synthesize(): Promise<SynthesisResult> {
    throw new ProviderNotConfiguredError(
      'tts',
      'Set TTS_PROVIDER=espeak (free, local) or openai-compatible to generate voiceovers. You can upload your own narration instead.',
    );
  }
}

const ESPEAK_VOICES: Voice[] = [
  { id: 'en-us', label: 'English (US)' },
  { id: 'en-gb', label: 'English (UK)' },
  { id: 'en-us+f3', label: 'English (US) – variant F3' },
  { id: 'en-us+m3', label: 'English (US) – variant M3' },
  { id: 'es', label: 'Spanish' },
  { id: 'fr', label: 'French' },
  { id: 'de', label: 'German' },
  { id: 'hi', label: 'Hindi' },
  { id: 'pt', label: 'Portuguese' },
];

/** Free offline TTS via espeak-ng. Robotic but real, and good for development and zero-cost setups. */
export class EspeakTts implements TtsProvider {
  readonly provider = 'espeak';
  readonly configured = true;
  readonly outputExt = 'wav' as const;
  constructor(private readonly binary: string) {}

  voices(): Voice[] {
    return ESPEAK_VOICES;
  }

  async synthesize(text: string, voiceId: string, speed: number, destPath: string): Promise<SynthesisResult> {
    if (!ESPEAK_VOICES.some((v) => v.id === voiceId)) throw new ProviderError(`Unknown voice ${voiceId}`, false, 'That voice is not available.');
    const wpm = Math.round(Math.min(2, Math.max(0.5, speed)) * 165);
    try {
      // Text is passed via stdin-free argument array; no shell is involved.
      await execFileAsync(this.binary, ['-v', voiceId, '-s', String(wpm), '-w', destPath, '--', text], {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      throw new ProviderError('espeak-ng failed', false, 'Voice generation failed.');
    }
    return { ext: 'wav', mimeType: 'audio/wav' };
  }
}

/** OpenAI-compatible /audio/speech endpoint. */
export class OpenAICompatibleTts implements TtsProvider {
  readonly provider = 'openai-compatible';
  readonly configured = true;
  readonly outputExt = 'mp3' as const;
  constructor(private readonly baseUrl: string, private readonly apiKey: string | undefined, private readonly model: string) {}

  voices(): Voice[] {
    return ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'].map((id) => ({ id, label: id }));
  }

  async synthesize(text: string, voiceId: string, speed: number, destPath: string): Promise<SynthesisResult> {
    const res = await fetchWithTimeout(
      `${this.baseUrl.replace(/\/$/u, '')}/audio/speech`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.model, voice: voiceId, input: text, speed, response_format: 'mp3' }),
      },
      120_000,
    );
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}`, isTransientStatus(res.status), 'Voice generation failed.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new ProviderError('Empty audio', true, 'Voice generation returned no audio.');
    await writeFile(destPath, buf, { mode: 0o600 });
    return { ext: 'mp3', mimeType: 'audio/mpeg' };
  }
}

export function createTtsProvider(env: {
  TTS_PROVIDER: 'none' | 'espeak' | 'openai-compatible';
  TTS_API_KEY?: string;
  TTS_MODEL?: string;
  TTS_BASE_URL?: string;
  ESPEAK_PATH: string;
}): TtsProvider {
  switch (env.TTS_PROVIDER) {
    case 'espeak':
      return new EspeakTts(env.ESPEAK_PATH);
    case 'openai-compatible':
      return new OpenAICompatibleTts(env.TTS_BASE_URL!, env.TTS_API_KEY, env.TTS_MODEL!);
    default:
      return new NoTts();
  }
}
