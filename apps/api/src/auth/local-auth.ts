import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT } from 'jose';
import type { Pool } from '@clipforge/server-core';
import { withServiceTx } from '@clipforge/server-core';
import { AppError, pgCode } from '../utils/errors.js';
import { LOCAL_ISSUER } from './verifier.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: { id: string; email: string };
}

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_DAYS = 30;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * DEVELOPMENT/TEST auth provider mirroring the Supabase session shape, so the product
 * works end to end without a Supabase project. Disabled in production by config validation.
 */
export class LocalAuthService {
  private readonly secret: Uint8Array;
  constructor(private readonly pool: Pool, secret: string) {
    this.secret = new TextEncoder().encode(secret);
  }

  private async issue(userId: string, email: string, client: { query: Pool['query'] }): Promise<Session> {
    const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS;
    const accessToken = await new SignJWT({ email, role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(LOCAL_ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(this.secret);
    const refreshToken = randomBytes(32).toString('base64url');
    await client.query(
      `insert into local_auth.refresh_tokens (user_id, token_hash, expires_at) values ($1, $2, now() + ($3 || ' days')::interval)`,
      [userId, sha256(refreshToken), String(REFRESH_TTL_DAYS)],
    );
    return { accessToken, refreshToken, expiresAt, user: { id: userId, email } };
  }

  async register(email: string, password: string): Promise<Session> {
    const passwordHash = await hashPassword(password);
    try {
      return await withServiceTx(this.pool, async (c) => {
        const u = await c.query<{ id: string }>('insert into auth.users (email) values ($1) returning id', [email]);
        const id = u.rows[0]!.id;
        await c.query('insert into local_auth.credentials (user_id, password_hash) values ($1, $2)', [id, passwordHash]);
        return this.issue(id, email, c);
      });
    } catch (err) {
      if (pgCode(err) === '23505') throw new AppError(409, 'email_taken', 'An account with this email already exists');
      throw err;
    }
  }

  async login(email: string, password: string): Promise<Session> {
    const r = await this.pool.query<{ id: string; password_hash: string }>(
      `select u.id, c.password_hash from auth.users u join local_auth.credentials c on c.user_id = u.id where u.email = $1`,
      [email],
    );
    const row = r.rows[0];
    // Always run a hash to keep timing similar for unknown emails.
    const ok = row ? await verifyPassword(password, row.password_hash) : (await hashPassword(password), false);
    if (!row || !ok) throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect');
    return this.issue(row.id, email, this.pool);
  }

  /** Rotates the refresh token: the old one is revoked even if it is replayed later. */
  async refresh(refreshToken: string): Promise<Session> {
    return withServiceTx(this.pool, async (c) => {
      const r = await c.query<{ id: string; user_id: string; email: string }>(
        `update local_auth.refresh_tokens t set revoked_at = now()
           from auth.users u
          where t.token_hash = $1 and t.revoked_at is null and t.expires_at > now() and u.id = t.user_id
          returning t.id, t.user_id, u.email`,
        [sha256(refreshToken)],
      );
      const row = r.rows[0];
      if (!row) throw new AppError(401, 'invalid_refresh_token', 'Your session has expired. Please sign in again.');
      return this.issue(row.user_id, row.email, c);
    });
  }

  async logout(refreshToken: string): Promise<void> {
    await this.pool.query(`update local_auth.refresh_tokens set revoked_at = now() where token_hash = $1 and revoked_at is null`, [
      sha256(refreshToken),
    ]);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const r = await this.pool.query<{ password_hash: string }>('select password_hash from local_auth.credentials where user_id = $1', [userId]);
    const row = r.rows[0];
    if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
      throw new AppError(400, 'invalid_credentials', 'Current password is incorrect');
    }
    await withServiceTx(this.pool, async (c) => {
      await c.query('update local_auth.credentials set password_hash = $2 where user_id = $1', [userId, await hashPassword(newPassword)]);
      await c.query('update local_auth.refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null', [userId]);
    });
  }
}
