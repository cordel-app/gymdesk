import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * #599: per-gym API key for the website self-registration endpoint.
 *
 * The key is 32 random bytes, so SHA-256 is the right hash: there is no
 * low-entropy secret to stretch, and the lookup must stay cheap because it
 * runs on an unauthenticated route.
 */
const KEY_PREFIX = 'gdk_';
const DISPLAY_PREFIX_LENGTH = 12;

export interface GeneratedWebsiteApiKey {
  /** Shown to the admin exactly once — never stored. */
  key: string;
  hash: string;
  /** Display-only: lets an admin tell which key is live. */
  prefix: string;
}

export function hashWebsiteApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateWebsiteApiKey(): GeneratedWebsiteApiKey {
  const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, hash: hashWebsiteApiKey(key), prefix: key.slice(0, DISPLAY_PREFIX_LENGTH) };
}

/** Constant-time check of a presented key against the stored hash. */
export function verifyWebsiteApiKey(presented: unknown, storedHash: string | null | undefined): boolean {
  if (typeof presented !== 'string' || !presented || !storedHash) return false;
  const a = Buffer.from(hashWebsiteApiKey(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
