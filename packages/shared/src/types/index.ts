import type { RenderErrorCategory, RenderJobStatus } from '../constants/output.js';
import type { PublishPrivacy, PublishStatus, SocialPlatform } from '../constants/social.js';
import type { Script, ScriptRequest, ProjectSettings } from '../schemas/api.js';
import type { Timeline } from '../schemas/timeline.js';

export interface ProjectSummary {
  id: string;
  name: string;
  template: string;
  createdAt: string;
  updatedAt: string;
  thumbnailUrl: string | null;
}

export interface ProjectDetail extends ProjectSummary {
  script: Script | null;
  scriptInput: Partial<ScriptRequest> | null;
  settings: ProjectSettings;
  timeline: Timeline;
  revision: number;
}

export type MediaKind = 'video' | 'image' | 'audio';
export type MediaStatus = 'pending' | 'ready' | 'failed';

export interface MediaAsset {
  id: string;
  projectId: string | null;
  kind: MediaKind;
  source: 'upload' | 'tts' | 'stock' | 'test';
  status: MediaStatus;
  originalName: string | null;
  mimeType: string;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  attribution: string | null;
  license: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface RenderJob {
  id: string;
  projectId: string;
  status: RenderJobStatus;
  profile: 'full' | 'preview';
  attempt: number;
  progress: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  outputSizeBytes: number | null;
  outputDurationMs: number | null;
  errorCategory: RenderErrorCategory | null;
  errorMessage: string | null;
}

export interface UsageSummary {
  periodStart: string;
  items: { kind: string; used: number; limit: number; unit: string }[];
  note: string;
}

export interface IntegrationStatus {
  llm: { configured: boolean; provider: string; model: string | null };
  tts: { configured: boolean; provider: string; voices: { id: string; label: string }[] };
  media: { configured: boolean; provider: string };
  alignment: { configured: boolean; provider: string };
  auth: { provider: 'supabase' | 'local' };
}

export interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string; details?: unknown };
}

export interface SocialAccount {
  id: string;
  platform: SocialPlatform;
  externalAccountId: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: 'active' | 'needs_reconnect';
  lastError: string | null;
  createdAt: string;
}

export interface SocialPlatformStatus {
  platform: SocialPlatform;
  label: string;
  configured: boolean;
}

export interface Publication {
  id: string;
  projectId: string;
  renderJobId: string;
  socialAccountId: string;
  platform: SocialPlatform;
  accountName: string | null;
  status: PublishStatus;
  trigger: 'auto' | 'manual';
  title: string;
  caption: string;
  privacy: PublishPrivacy;
  scheduledAt: string | null;
  attempt: number;
  externalPostId: string | null;
  externalUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}
