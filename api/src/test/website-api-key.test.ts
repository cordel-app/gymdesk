// Unit tests for infra/website-api-key.ts (#599) — pure crypto helpers, no DB or HTTP.

import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { generateWebsiteApiKey, hashWebsiteApiKey, verifyWebsiteApiKey } from '../infra/website-api-key';

describe('generateWebsiteApiKey', () => {
  it('returns a gdk_-prefixed base64url key carrying 32 random bytes', () => {
    const { key } = generateWebsiteApiKey();
    expect(key.startsWith('gdk_')).toBe(true);
    const body = key.slice(4);
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(body, 'base64url')).toHaveLength(32);
  });

  it('exposes the first 12 characters of the key as the display prefix', () => {
    const { key, prefix } = generateWebsiteApiKey();
    expect(prefix).toHaveLength(12);
    expect(prefix).toBe(key.slice(0, 12));
    expect(prefix.startsWith('gdk_')).toBe(true);
  });

  it('returns the sha256 hash of the key, never the key itself', () => {
    const { key, hash } = generateWebsiteApiKey();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashWebsiteApiKey(key));
    expect(hash).not.toContain(key);
  });

  it('generates a different key on every call', () => {
    const keys = new Set(Array.from({ length: 20 }, () => generateWebsiteApiKey().key));
    expect(keys.size).toBe(20);
  });
});

describe('hashWebsiteApiKey', () => {
  it('is 64 lowercase hex characters', () => {
    expect(hashWebsiteApiKey('gdk_anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(hashWebsiteApiKey('gdk_same')).toBe(hashWebsiteApiKey('gdk_same'));
  });

  it('is plain SHA-256 of the utf8 key', () => {
    expect(hashWebsiteApiKey('gdk_known')).toBe(createHash('sha256').update('gdk_known', 'utf8').digest('hex'));
  });

  it('differs for different keys', () => {
    expect(hashWebsiteApiKey('gdk_a')).not.toBe(hashWebsiteApiKey('gdk_b'));
  });
});

describe('verifyWebsiteApiKey', () => {
  const { key, hash } = generateWebsiteApiKey();

  it('accepts the right key', () => {
    expect(verifyWebsiteApiKey(key, hash)).toBe(true);
  });

  it('rejects a different valid-looking key', () => {
    expect(verifyWebsiteApiKey(generateWebsiteApiKey().key, hash)).toBe(false);
  });

  it('rejects a key that differs by one character', () => {
    const last = key.slice(-1) === 'A' ? 'B' : 'A';
    expect(verifyWebsiteApiKey(key.slice(0, -1) + last, hash)).toBe(false);
  });

  it('rejects the hash presented as the key', () => {
    expect(verifyWebsiteApiKey(hash, hash)).toBe(false);
  });

  it('rejects an empty key', () => {
    expect(verifyWebsiteApiKey('', hash)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 12345],
    ['an array (repeated header)', [key]],
    ['an object', { key }],
  ])('rejects a non-string key: %s', (_label, presented) => {
    expect(verifyWebsiteApiKey(presented, hash)).toBe(false);
  });

  it('rejects when no hash is stored (null / undefined / empty)', () => {
    expect(verifyWebsiteApiKey(key, null)).toBe(false);
    expect(verifyWebsiteApiKey(key, undefined)).toBe(false);
    expect(verifyWebsiteApiKey(key, '')).toBe(false);
  });

  it('rejects a malformed stored hash without throwing', () => {
    expect(verifyWebsiteApiKey(key, 'not-hex-at-all')).toBe(false);
    expect(verifyWebsiteApiKey(key, hash.slice(0, 32))).toBe(false);
    expect(verifyWebsiteApiKey(key, `${hash}00`)).toBe(false);
  });
});
