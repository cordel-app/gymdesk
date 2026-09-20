import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/**
 * #599: per-gym API key for the website self-registration endpoint.
 *
 * The key is 32 random bytes and only a salted scrypt digest of it is stored,
 * as `scrypt$<salt hex>$<digest hex>`. scrypt is deliberately slow and this is
 * checked on an unauthenticated route, so `verifyWebsiteApiKey` compares the
 * stored display prefix first: a caller who does not hold the key never gets
 * as far as the digest, and junk traffic cannot be used to burn CPU.
 */
const KEY_PREFIX = 'gdk_';
const DISPLAY_PREFIX_LENGTH = 12;
const SALT_BYTES = 16;
const DIGEST_BYTES = 32;
const SCHEME = 'scrypt';

export interface GeneratedWebsiteApiKey {
  /** Shown to the admin exactly once — never stored. */
  key: string;
  hash: string;
  /** Display-only: lets an admin tell which key is live. Also the verify pre-filter. */
  prefix: string;
}

export async function hashWebsiteApiKey(key: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const digest = await scryptAsync(key, salt, DIGEST_BYTES);
  return `${SCHEME}$${salt.toString('hex')}$${digest.toString('hex')}`;
}

export async function generateWebsiteApiKey(): Promise<GeneratedWebsiteApiKey> {
  const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, hash: await hashWebsiteApiKey(key), prefix: key.slice(0, DISPLAY_PREFIX_LENGTH) };
}

/** Constant-time check of a presented key against the stored digest. */
export async function verifyWebsiteApiKey(
  presented: unknown,
  storedHash: string | null | undefined,
  storedPrefix: string | null | undefined,
): Promise<boolean> {
  if (typeof presented !== 'string' || !presented || !storedHash || !storedPrefix) return false;
  if (presented.slice(0, DISPLAY_PREFIX_LENGTH) !== storedPrefix) return false;

  const [scheme, saltHex, digestHex] = storedHash.split('$');
  if (scheme !== SCHEME || !saltHex || !digestHex) return false;
  const expected = Buffer.from(digestHex, 'hex');
  if (expected.length !== DIGEST_BYTES) return false;

  const actual = await scryptAsync(presented, Buffer.from(saltHex, 'hex'), DIGEST_BYTES);
  return timingSafeEqual(actual, expected);
}
