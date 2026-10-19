import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for OAuth tokens at rest. Format: `v1.<iv>.<tag>.<ciphertext>` (base64url).
 * The key never leaves the server; the authenticated DB role cannot read token columns.
 */
export class TokenCipher {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('Token encryption key must be 32 bytes');
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split('.');
    if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unrecognized token format');
    const ivBuf = Buffer.from(iv, 'base64url');
    const tagBuf = Buffer.from(tag, 'base64url');
    // Pin lengths: GCM would otherwise accept a truncated tag, which weakens authentication.
    if (ivBuf.length !== 12 || tagBuf.length !== 16) throw new Error('Unrecognized token format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, ivBuf, { authTagLength: 16 });
    decipher.setAuthTag(tagBuf);
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }
}
