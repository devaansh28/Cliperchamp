import type { PublishPrivacy, SocialPlatform } from '@clipforge/shared';

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** null when the platform does not say. */
  expiresAt: Date | null;
  scopes: string[];
}

export interface SocialProfile {
  externalAccountId: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface PublishInput {
  accessToken: string;
  externalAccountId: string;
  filePath: string;
  fileSize: number;
  durationMs: number;
  title: string;
  caption: string;
  privacy: PublishPrivacy;
  /** A temporary public HTTPS URL of the video (needed by platforms that pull the file). */
  publicVideoUrl: () => Promise<string>;
  /** Called as soon as the platform has accepted the upload, so a retry can resume instead of re-posting. */
  onPlatformRef: (ref: string) => Promise<void>;
  /** A platform handle saved by an earlier attempt. */
  resumeRef: string | null;
}

export interface PublishResult {
  externalPostId: string;
  url: string | null;
}

export interface SocialPlatformAdapter {
  readonly platform: SocialPlatform;
  readonly configured: boolean;
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<TokenSet>;
  refresh(tokens: TokenSet): Promise<TokenSet>;
  fetchProfile(tokens: TokenSet): Promise<SocialProfile>;
  publish(input: PublishInput): Promise<PublishResult>;
  /** Best effort; failures are ignored. */
  revoke(tokens: TokenSet): Promise<void>;
}

/** The account's authorization no longer works; the user must reconnect. Never retried. */
export class SocialAuthError extends Error {
  constructor(message: string, readonly userMessage = 'This account needs to be reconnected.') {
    super(message);
    this.name = 'SocialAuthError';
  }
}

/** A platform rejected or failed a request. `transient` decides whether the job retries. */
export class SocialPlatformError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly userMessage: string,
  ) {
    super(message);
    this.name = 'SocialPlatformError';
  }
}
