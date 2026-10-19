import type { SocialPlatform } from '@clipforge/shared';
import type { Env } from '../config/env.js';
import { ProviderNotConfiguredError } from '../providers/errors.js';
import { TokenCipher } from './crypto.js';
import { InstagramAdapter } from './instagram.js';
import { TikTokAdapter } from './tiktok.js';
import type { SocialPlatformAdapter } from './types.js';
import { YouTubeAdapter } from './youtube.js';

export interface SocialRegistry {
  cipher: TokenCipher | null;
  adapters: Record<SocialPlatform, SocialPlatformAdapter>;
  /** Adapter for a platform, or a clear "not configured" error. */
  get(platform: SocialPlatform): SocialPlatformAdapter;
  /** Where platforms send users back after they approve access. */
  redirectUri(platform: SocialPlatform): string;
}

const HINTS: Record<SocialPlatform, string> = {
  youtube: 'Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET (Google Cloud OAuth client with the YouTube Data API v3) and SOCIAL_TOKEN_ENCRYPTION_KEY.',
  tiktok: 'Set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET (TikTok app with Login Kit and the Content Posting API) and SOCIAL_TOKEN_ENCRYPTION_KEY.',
  instagram: 'Set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET (Meta app with Instagram API with Instagram Login) and SOCIAL_TOKEN_ENCRYPTION_KEY.',
};

export function createSocialRegistry(env: Env, adapters?: Partial<Record<SocialPlatform, SocialPlatformAdapter>>): SocialRegistry {
  const cipher = env.SOCIAL_TOKEN_ENCRYPTION_KEY ? new TokenCipher(env.SOCIAL_TOKEN_ENCRYPTION_KEY) : null;
  const all: Record<SocialPlatform, SocialPlatformAdapter> = {
    youtube: adapters?.youtube ?? new YouTubeAdapter(env.YOUTUBE_CLIENT_ID, env.YOUTUBE_CLIENT_SECRET),
    tiktok: adapters?.tiktok ?? new TikTokAdapter(env.TIKTOK_CLIENT_KEY, env.TIKTOK_CLIENT_SECRET),
    instagram: adapters?.instagram ?? new InstagramAdapter(env.INSTAGRAM_APP_ID, env.INSTAGRAM_APP_SECRET),
  };
  return {
    cipher,
    adapters: all,
    get(platform) {
      const adapter = all[platform];
      if (!adapter.configured || !cipher) throw new ProviderNotConfiguredError('social', HINTS[platform]);
      return adapter;
    },
    redirectUri(platform) {
      return `${env.API_BASE_URL.replace(/\/$/u, '')}/api/social/oauth/${platform}/callback`;
    },
  };
}

export function isConfigured(registry: SocialRegistry, platform: SocialPlatform): boolean {
  return Boolean(registry.cipher) && registry.adapters[platform].configured;
}
