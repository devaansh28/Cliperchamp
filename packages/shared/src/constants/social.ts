/** Social platforms ClipForge can publish to. */
export const SOCIAL_PLATFORMS = ['youtube', 'tiktok', 'instagram'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const PUBLISH_STATUSES = ['queued', 'processing', 'published', 'failed', 'cancelled'] as const;
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

export const PUBLISH_PRIVACY = ['public', 'unlisted', 'private'] as const;
export type PublishPrivacy = (typeof PUBLISH_PRIVACY)[number];

export interface PlatformRules {
  label: string;
  product: string;
  /** Longest video the platform accepts through its API for this format. */
  maxDurationSec: number;
  minDurationSec: number;
  titleMax: number;
  captionMax: number;
  /** Privacy values that map to something on the platform. */
  privacy: readonly PublishPrivacy[];
  usesTitle: boolean;
}

/** Limits used to validate posts before they are queued. Platforms change these; keep them conservative. */
export const PLATFORM_RULES: Record<SocialPlatform, PlatformRules> = {
  youtube: { label: 'YouTube', product: 'Shorts', maxDurationSec: 180, minDurationSec: 1, titleMax: 100, captionMax: 5000, privacy: ['public', 'unlisted', 'private'], usesTitle: true },
  tiktok: { label: 'TikTok', product: 'TikTok video', maxDurationSec: 600, minDurationSec: 3, titleMax: 0, captionMax: 2200, privacy: ['public', 'private'], usesTitle: false },
  instagram: { label: 'Instagram', product: 'Reels', maxDurationSec: 900, minDurationSec: 3, titleMax: 0, captionMax: 2200, privacy: ['public'], usesTitle: false },
};
