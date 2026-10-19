/** Raised when an integration is not configured. The API turns it into a clear 503 with setup guidance. */
export class ProviderNotConfiguredError extends Error {
  constructor(readonly capability: 'llm' | 'tts' | 'media' | 'alignment', readonly hint: string) {
    super(`${capability} provider is not configured`);
    this.name = 'ProviderNotConfiguredError';
  }
}

/** Raised when a configured provider fails. `transient` says whether retrying may help. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly userMessage = 'The AI provider could not complete the request. Please try again.',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw new ProviderError(`Request failed: ${(err as Error).name}`, true);
  } finally {
    clearTimeout(timer);
  }
}

export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
