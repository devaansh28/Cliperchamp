import type {
  CaptionSegment,
  IntegrationStatus,
  MediaAsset,
  ProjectSettings,
  Publication,
  PublishRequest,
  SocialAccount,
  SocialPlatform,
  SocialPlatformStatus,
  ProjectDetail,
  ProjectSummary,
  RenderJob,
  Script,
  ScriptRequest,
  Timeline,
  UsageSummary,
} from '@clipforge/shared';
import { auth } from './auth';
import { webEnv } from './env';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export type MediaAssetWithUrl = MediaAsset & { url: string | null };

export interface StockResult {
  provider: 'pexels';
  externalId: string;
  kind: 'video' | 'image';
  previewUrl: string;
  width: number;
  height: number;
  durationMs: number | null;
  attribution: string;
  license: string;
  pageUrl: string;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  raw?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const token = await auth.getAccessToken();
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const res = await fetch(`${webEnv.apiBaseUrl}/api${path}`, {
    method: opts.method ?? 'GET',
    signal: opts.signal,
    headers: {
      ...(opts.body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
  });
  if (res.status === 401 && !retried) {
    const fresh = await auth.refresh();
    if (fresh) return request<T>(path, opts, true);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError(res.status, body?.error?.code ?? 'http_error', body?.error?.message ?? `Request failed (${res.status})`, body?.error?.details);
  }
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  me: () => request<{ id: string; email: string | null; displayName: string | null }>('/me'),
  updateMe: (displayName: string | null) => request<{ displayName: string | null }>('/me', { method: 'PATCH', body: { displayName } }),
  integrations: () => request<IntegrationStatus>('/integrations'),
  usage: () => request<UsageSummary>('/usage'),

  listProjects: (params: { search?: string; sort?: 'updated' | 'created' | 'name' }) => {
    const q = new URLSearchParams();
    if (params.search) q.set('search', params.search);
    if (params.sort) q.set('sort', params.sort);
    return request<ProjectSummary[]>(`/projects?${q.toString()}`);
  },
  createProject: (name: string, template?: string) => request<ProjectSummary>('/projects', { method: 'POST', body: { name, template } }),
  getProject: (id: string) => request<ProjectDetail>(`/projects/${id}`),
  updateProject: (id: string, patch: { name?: string; script?: Script | null; scriptInput?: Partial<ScriptRequest>; settings?: Partial<ProjectSettings> }) =>
    request<ProjectDetail>(`/projects/${id}`, { method: 'PATCH', body: patch }),
  saveTimeline: (id: string, timeline: Timeline, revision: number) =>
    request<{ revision: number; durationMs: number }>(`/projects/${id}/timeline`, { method: 'PUT', body: { timeline, revision } }),
  duplicateProject: (id: string) => request<ProjectSummary>(`/projects/${id}/duplicate`, { method: 'POST' }),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),

  generateScript: (id: string, input: ScriptRequest) => request<Script>(`/projects/${id}/script/generate`, { method: 'POST', body: input }),
  captionsFromScript: (id: string, body: { narrationAssetId?: string; maxWordsPerSegment?: number }) =>
    request<{ captions: CaptionSegment[]; timing: 'estimated'; basedOnAudioDuration: boolean }>(`/projects/${id}/captions/from-script`, { method: 'POST', body }),
  alignCaptions: (id: string, body: { narrationAssetId: string; maxWordsPerSegment?: number }) =>
    request<{ captions: CaptionSegment[]; timing: 'aligned' }>(`/projects/${id}/captions/align`, { method: 'POST', body }),
  mediaSuggestions: (id: string) =>
    request<{ configured: boolean; scenes: { index: number; query: string; results: StockResult[] }[] }>(`/projects/${id}/media-suggestions`),

  listMedia: (projectId?: string) => request<MediaAssetWithUrl[]>(`/media${projectId ? `?projectId=${projectId}` : ''}`),
  getMedia: (id: string) => request<MediaAssetWithUrl>(`/media/${id}`),
  uploadMedia: (file: File, projectId?: string) => {
    const form = new FormData();
    if (projectId) form.set('projectId', projectId);
    form.set('file', file);
    return request<MediaAsset>('/media', { method: 'POST', body: form });
  },
  deleteMedia: (id: string) => request<void>(`/media/${id}`, { method: 'DELETE' }),
  searchStock: (q: string) => request<StockResult[]>(`/media/stock/search?q=${encodeURIComponent(q)}`),
  importStock: (externalId: string, projectId?: string) =>
    request<MediaAsset>('/media/stock/import', { method: 'POST', body: { provider: 'pexels', externalId, projectId } }),

  voices: () => request<{ configured: boolean; provider: string; voices: { id: string; label: string }[] }>('/voices'),
  previewVoice: async (body: { text: string; voiceId: string; speed: number }) => {
    const res = await request<Response>('/voice/preview', { method: 'POST', body, raw: true });
    return res.blob();
  },
  generateVoiceover: (projectId: string, body: { text?: string; voiceId: string; speed: number }) =>
    request<MediaAsset>(`/projects/${projectId}/voiceover`, { method: 'POST', body }),

  createRender: (projectId: string, profile: 'full' | 'preview', idempotencyKey: string) =>
    request<RenderJob>(`/projects/${projectId}/renders`, { method: 'POST', body: { profile }, headers: { 'idempotency-key': idempotencyKey } }),
  listRenders: (projectId: string) => request<RenderJob[]>(`/projects/${projectId}/renders`),
  getRender: (id: string) => request<RenderJob>(`/renders/${id}`),
  cancelRender: (id: string) => request<RenderJob>(`/renders/${id}/cancel`, { method: 'POST' }),
  renderDownload: (id: string) => request<{ url: string; expiresInSeconds: number }>(`/renders/${id}/download`),
  renderPlayback: (id: string) => request<{ url: string; expiresInSeconds: number }>(`/renders/${id}/playback`),

  socialAccounts: () => request<{ platforms: SocialPlatformStatus[]; accounts: SocialAccount[] }>('/social/accounts'),
  connectSocial: (platform: SocialPlatform) => request<{ authorizeUrl: string }>(`/social/${platform}/connect`, { method: 'POST' }),
  disconnectSocial: (id: string) => request<void>(`/social/accounts/${id}`, { method: 'DELETE' }),
  publishRender: (renderId: string, body: PublishRequest) =>
    request<{ created: Publication[]; existing: Publication[] }>(`/renders/${renderId}/publish`, { method: 'POST', body }),
  projectPublications: (projectId: string) => request<Publication[]>(`/projects/${projectId}/publications`),
  cancelPublication: (id: string) => request<Publication>(`/publications/${id}/cancel`, { method: 'POST' }),
  retryPublication: (id: string) => request<Publication>(`/publications/${id}/retry`, { method: 'POST' }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
