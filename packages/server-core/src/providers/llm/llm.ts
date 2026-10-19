import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { ScriptSchema, type Script, type ScriptRequest } from '@clipforge/shared';
import { fetchWithTimeout, isTransientStatus, ProviderError, ProviderNotConfiguredError } from '../errors.js';

export interface ScriptGenerator {
  readonly provider: string;
  readonly model: string | null;
  readonly configured: boolean;
  generateScript(input: ScriptRequest): Promise<Script>;
}

/** Shape requested from the model. Kept constraint-free for structured-output compatibility; ScriptSchema validates afterwards. */
const ModelScriptSchema = z.object({
  hook: z.string(),
  segments: z.array(z.object({ narration: z.string(), scene: z.string() })),
  callToAction: z.string().nullable(),
  estimatedDurationSec: z.number(),
});

export function buildScriptPrompt(input: ScriptRequest): { system: string; user: string } {
  const system =
    'You write narration scripts for vertical short-form videos (TikTok, Reels, Shorts). ' +
    'Write spoken narration only: no stage directions or emoji inside narration. ' +
    'Each segment is one or two sentences, paired with a short visual scene description for stock footage search. ' +
    'Speech pace is about 150 words per minute; size the script to the target duration. ' +
    'Respond with JSON only, matching the requested schema.';
  const lines = [
    `Topic: ${input.topic}`,
    `Audience: ${input.audience}`,
    `Language: ${input.language} (write the narration in this language)`,
    `Tone: ${input.tone}`,
    `Target duration: ${input.targetDurationSec} seconds`,
    `Objective: ${input.objective}`,
  ];
  if (input.sourceScript) lines.push('', 'Rewrite and tighten this source script:', input.sourceScript);
  lines.push(
    '',
    'Return JSON: {"hook": string, "segments": [{"narration": string, "scene": string}], "callToAction": string|null, "estimatedDurationSec": number}',
  );
  return { system, user: lines.join('\n') };
}

/** Validate whatever a provider returned. Throws ProviderError (non-transient) on invalid output. */
export function validateScriptOutput(raw: unknown): Script {
  const parsed = ScriptSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProviderError(
      `Provider returned an invalid script: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
      false,
      'The AI returned a script in an unexpected format. Try again or edit the script manually.',
    );
  }
  return parsed.data;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/u, '').replace(/```$/u, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new ProviderError('Provider response was not JSON', false, 'The AI returned an unreadable response. Please try again.');
  }
}

export class NoScriptGenerator implements ScriptGenerator {
  readonly provider = 'none';
  readonly model = null;
  readonly configured = false;
  async generateScript(): Promise<Script> {
    throw new ProviderNotConfiguredError(
      'llm',
      'Set LLM_PROVIDER (anthropic or openai-compatible), LLM_API_KEY and LLM_MODEL to enable AI scripts. You can still write the script manually.',
    );
  }
}

export class AnthropicScriptGenerator implements ScriptGenerator {
  readonly provider = 'anthropic';
  readonly configured = true;
  private readonly client: Anthropic;

  constructor(apiKey: string, readonly model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async generateScript(input: ScriptRequest): Promise<Script> {
    const { system, user } = buildScriptPrompt(input);
    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 16000,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { format: zodOutputFormat(ModelScriptSchema) },
      });
      if (response.stop_reason === 'refusal') {
        throw new ProviderError('Model declined the request', false, 'The AI declined this topic. Try a different topic or write the script manually.');
      }
      if (response.stop_reason === 'max_tokens') {
        throw new ProviderError('Model output was truncated', true, 'The script was too long to generate. Try a shorter target duration.');
      }
      return validateScriptOutput(response.parsed_output);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof Anthropic.RateLimitError) throw new ProviderError('Rate limited', true, 'The AI provider is busy. Please try again shortly.');
      if (err instanceof Anthropic.AuthenticationError) throw new ProviderError('Authentication failed', false, 'The AI provider rejected the configured API key.');
      if (err instanceof Anthropic.BadRequestError) throw new ProviderError(`Bad request (${err.status})`, false);
      if (err instanceof Anthropic.APIError) throw new ProviderError(`API error ${String(err.status)}`, true);
      throw new ProviderError(`Unexpected error: ${(err as Error).name}`, true);
    }
  }
}

/** OpenAI-compatible chat completions (OpenAI, Groq, OpenRouter, Ollama, LM Studio...). */
export class OpenAICompatibleScriptGenerator implements ScriptGenerator {
  readonly provider = 'openai-compatible';
  readonly configured = true;

  constructor(private readonly baseUrl: string, private readonly apiKey: string | undefined, readonly model: string) {}

  async generateScript(input: ScriptRequest): Promise<Script> {
    const { system, user } = buildScriptPrompt(input);
    const res = await fetchWithTimeout(
      `${this.baseUrl.replace(/\/$/u, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.8,
        }),
      },
      120_000,
    );
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}`, isTransientStatus(res.status));
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new ProviderError('Empty completion', true);
    return validateScriptOutput(extractJson(content));
  }
}

export function createScriptGenerator(env: {
  LLM_PROVIDER: 'none' | 'anthropic' | 'openai-compatible';
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_BASE_URL?: string;
}): ScriptGenerator {
  switch (env.LLM_PROVIDER) {
    case 'anthropic':
      return new AnthropicScriptGenerator(env.LLM_API_KEY!, env.LLM_MODEL ?? 'claude-opus-5-5');
    case 'openai-compatible':
      return new OpenAICompatibleScriptGenerator(env.LLM_BASE_URL!, env.LLM_API_KEY, env.LLM_MODEL!);
    default:
      return new NoScriptGenerator();
  }
}
