import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '@clipforge/server-core';

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface TokenVerifier {
  verify(token: string): Promise<AuthUser>;
}

export class InvalidTokenError extends Error {
  constructor() {
    super('Invalid or expired session');
    this.name = 'InvalidTokenError';
  }
}

function toUser(payload: JWTPayload): AuthUser {
  if (typeof payload.sub !== 'string' || payload.role === 'anon') throw new InvalidTokenError();
  return { id: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
}

export const LOCAL_ISSUER = 'clipforge-local';

/** Verifies Supabase Auth access tokens: HS256 with the legacy JWT secret, or asymmetric keys from the project's JWKS. */
export class SupabaseTokenVerifier implements TokenVerifier {
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;
  private readonly secret?: Uint8Array;
  private readonly issuer: string;

  constructor(supabaseUrl: string, jwtSecret?: string) {
    this.issuer = `${supabaseUrl.replace(/\/$/u, '')}/auth/v1`;
    if (jwtSecret) this.secret = new TextEncoder().encode(jwtSecret);
    else this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
  }

  async verify(token: string): Promise<AuthUser> {
    try {
      const opts = { issuer: this.issuer, audience: 'authenticated' };
      const { payload } = this.secret ? await jwtVerify(token, this.secret, opts) : await jwtVerify(token, this.jwks!, opts);
      return toUser(payload);
    } catch {
      throw new InvalidTokenError();
    }
  }
}

/** Verifies tokens issued by the development-only local auth provider. */
export class LocalTokenVerifier implements TokenVerifier {
  private readonly secret: Uint8Array;
  constructor(secret: string) {
    this.secret = new TextEncoder().encode(secret);
  }
  async verify(token: string): Promise<AuthUser> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { issuer: LOCAL_ISSUER, audience: 'authenticated', algorithms: ['HS256'] });
      return toUser(payload);
    } catch {
      throw new InvalidTokenError();
    }
  }
}

export function createTokenVerifier(env: Env): TokenVerifier {
  return env.AUTH_PROVIDER === 'local'
    ? new LocalTokenVerifier(env.AUTH_JWT_SECRET!)
    : new SupabaseTokenVerifier(env.SUPABASE_URL!, env.SUPABASE_JWT_SECRET);
}
