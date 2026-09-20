// #599: unit tests for the per-gym website API key helper. No DB, no HTTP.

import { describe, expect, it } from 'vitest';
import { generateWebsiteApiKey, hashWebsiteApiKey, verifyWebsiteApiKey } from '../infra/website-api-key';

const STORED_FORMAT = /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/;

describe('generateWebsiteApiKey', () => {
  it('returns a gdk_ key carrying 32 random bytes of base64url', async () => {
    const { key } = await generateWebsiteApiKey();
    expect(key).toMatch(/^gdk_[A-Za-z0-9_-]{43}$/);
  });

  it('exposes the first 12 characters as the display prefix', async () => {
    const { key, prefix } = await generateWebsiteApiKey();
    expect(prefix).toBe(key.slice(0, 12));
  });

  it('returns a salted scrypt digest, never the key itself', async () => {
    const { key, hash } = await generateWebsiteApiKey();
    expect(hash).toMatch(STORED_FORMAT);
    expect(hash).not.toContain(key);
    expect(hash.length).toBeLessThanOrEqual(128); // gyms.website_api_key_hash VARCHAR(128)
  });

  it('never repeats a key', async () => {
    const keys = await Promise.all(Array.from({ length: 5 }, async () => (await generateWebsiteApiKey()).key));
    expect(new Set(keys).size).toBe(5);
  });
});

describe('hashWebsiteApiKey', () => {
  it('salts: the same key hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashWebsiteApiKey('gdk_same'), hashWebsiteApiKey('gdk_same')]);
    expect(a).toMatch(STORED_FORMAT);
    expect(a).not.toBe(b);
  });
});

describe('verifyWebsiteApiKey', () => {
  it('accepts the right key', async () => {
    const { key, hash, prefix } = await generateWebsiteApiKey();
    expect(await verifyWebsiteApiKey(key, hash, prefix)).toBe(true);
  });

  it('rejects another key', async () => {
    const { hash, prefix } = await generateWebsiteApiKey();
    expect(await verifyWebsiteApiKey((await generateWebsiteApiKey()).key, hash, prefix)).toBe(false);
  });

  it('rejects a key that shares the prefix but differs in its last character', async () => {
    const { key, hash, prefix } = await generateWebsiteApiKey();
    const last = key.endsWith('A') ? 'B' : 'A';
    expect(await verifyWebsiteApiKey(key.slice(0, -1) + last, hash, prefix)).toBe(false);
  });

  it('rejects when the stored prefix does not match, without needing the digest', async () => {
    const { key, hash } = await generateWebsiteApiKey();
    expect(await verifyWebsiteApiKey(key, hash, 'gdk_XXXXXXXX')).toBe(false);
  });

  it('rejects the stored hash presented as the key', async () => {
    const { hash, prefix } = await generateWebsiteApiKey();
    expect(await verifyWebsiteApiKey(hash, hash, prefix)).toBe(false);
  });

  it('rejects empty and non-string input', async () => {
    const { hash, prefix } = await generateWebsiteApiKey();
    for (const presented of ['', undefined, null, 42, ['gdk_x'], {}]) {
      expect(await verifyWebsiteApiKey(presented, hash, prefix)).toBe(false);
    }
  });

  it('rejects when the gym has no key configured', async () => {
    const { key, hash, prefix } = await generateWebsiteApiKey();
    expect(await verifyWebsiteApiKey(key, null, null)).toBe(false);
    expect(await verifyWebsiteApiKey(key, undefined, undefined)).toBe(false);
    expect(await verifyWebsiteApiKey(key, '', prefix)).toBe(false);
    expect(await verifyWebsiteApiKey(key, hash, null)).toBe(false);
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    const { key, hash, prefix } = await generateWebsiteApiKey();
    const [, salt, digest] = hash.split('$');
    for (const stored of ['not-a-hash', `sha256$${salt}$${digest}`, `scrypt$${salt}`, `scrypt$${salt}$${digest.slice(0, 32)}`, `scrypt$${salt}$zz`]) {
      expect(await verifyWebsiteApiKey(key, stored, prefix)).toBe(false);
    }
  });
});
