export const DEFAULT_OUTPUT_PROFILE = {
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: 'h264',
  audioCodec: 'aac',
  pixelFormat: 'yuv420p',
} as const;

/** Small profile for fast draft renders and tests. Same 9:16 aspect ratio. */
export const PREVIEW_OUTPUT_PROFILE = {
  ...DEFAULT_OUTPUT_PROFILE,
  width: 540,
  height: 960,
} as const;

export const RENDER_JOB_STATUSES = ['queued', 'processing', 'completed', 'failed', 'cancelled'] as const;
export type RenderJobStatus = (typeof RENDER_JOB_STATUSES)[number];

export const RENDER_ERROR_CATEGORIES = [
  'validation',
  'media',
  'render',
  'storage',
  'timeout',
  'cancelled',
  'internal',
] as const;
export type RenderErrorCategory = (typeof RENDER_ERROR_CATEGORIES)[number];

export const QUEUE_NAMES = {
  renderVideo: 'render-video',
  generateVoice: 'generate-voice',
  processMedia: 'process-media',
  cleanup: 'cleanup',
} as const;

export const ALLOWED_UPLOAD_MIME = {
  video: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'],
  image: ['image/png', 'image/jpeg', 'image/webp'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/x-m4a'],
} as const;

export const USAGE_KINDS = ['script_generation', 'voice_seconds', 'storage_bytes', 'render_seconds', 'export'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];
