import pino, { type Logger } from 'pino';

/** Structured logger. Redacts credentials, prompts and signed URLs wherever they might appear. */
export function createLogger(name: string, level: string): Logger {
  return pino({
    name,
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.token',
        '*.accessToken',
        '*.refreshToken',
        '*.apiKey',
        '*.signedUrl',
        '*.url',
        '*.prompt',
        '*.text',
      ],
      censor: '[redacted]',
    },
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type { Logger };
