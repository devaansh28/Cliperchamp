import { ProbeError, ProviderError, StorageError } from '@clipforge/server-core';
import type { RenderErrorCategory } from '@clipforge/shared';

/** A failure that will not succeed on retry (bad input, unsupported media). */
export class PermanentJobError extends Error {
  constructor(
    readonly category: RenderErrorCategory,
    readonly userMessage: string,
    detail?: string,
  ) {
    super(detail ?? userMessage);
    this.name = 'PermanentJobError';
  }
}

export class JobCancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'JobCancelledError';
  }
}

export interface ClassifiedError {
  category: RenderErrorCategory;
  userMessage: string;
  retryable: boolean;
  detail: string;
}

/** Map any thrown error to a category, a safe message, and whether a retry could help. */
export function classifyError(err: unknown): ClassifiedError {
  const detail = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 2000) : String(err).slice(0, 2000);
  if (err instanceof JobCancelledError) return { category: 'cancelled', userMessage: 'Cancelled', retryable: false, detail };
  if (err instanceof PermanentJobError) return { category: err.category, userMessage: err.userMessage, retryable: false, detail };
  if (err instanceof ProbeError) return { category: 'media', userMessage: 'A media file could not be read. Try re-uploading it.', retryable: false, detail };
  if (err instanceof StorageError) {
    return { category: 'storage', userMessage: 'Storage was unavailable while rendering.', retryable: err.transient, detail };
  }
  if (err instanceof ProviderError) return { category: 'internal', userMessage: err.userMessage, retryable: err.transient, detail };
  if (err instanceof Error && /timed? ?out/iu.test(err.message)) {
    return { category: 'timeout', userMessage: 'Rendering took too long and was stopped.', retryable: true, detail };
  }
  if (err instanceof Error && /renderMedia\(\) got cancelled|cancelled/iu.test(err.message)) {
    return { category: 'cancelled', userMessage: 'Cancelled', retryable: false, detail };
  }
  return { category: 'render', userMessage: 'Rendering failed. Please try again.', retryable: true, detail };
}
