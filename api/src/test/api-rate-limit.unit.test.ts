import { describe, it, expect } from 'vitest';
import {
  API_RATE_LIMIT_DEFAULT_MAX,
  API_RATE_LIMIT_WINDOW_MS,
  apiRateLimitKey,
  apiRateLimitMax,
  bearerTokenSubject,
} from '../domain/apiRateLimit';

function jwtWith(payload: unknown): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.c2ln`;
}

describe('apiRateLimitMax', () => {
  it('keeps the previous 500 when nothing is set', () => {
    expect(API_RATE_LIMIT_DEFAULT_MAX).toBe(500);
    expect(apiRateLimitMax({})).toBe(500);
    expect(apiRateLimitMax({ API_RATE_LIMIT_MAX: '' })).toBe(500);
  });

  it('honours a positive whole number', () => {
    expect(apiRateLimitMax({ API_RATE_LIMIT_MAX: '5000' })).toBe(5000);
    expect(apiRateLimitMax({ API_RATE_LIMIT_MAX: '1500.9' })).toBe(1500);
  });

  it('falls back rather than disabling or locking out the API', () => {
    for (const bad of ['0', '-5', 'abc', '0.5', 'Infinity']) {
      expect(apiRateLimitMax({ API_RATE_LIMIT_MAX: bad })).toBe(500);
    }
  });

  it('counts over 15 minutes', () => {
    expect(API_RATE_LIMIT_WINDOW_MS).toBe(15 * 60 * 1000);
  });
});

describe('bearerTokenSubject (#1395)', () => {
  it('reads the subject of a bearer JWT without verifying it', () => {
    expect(bearerTokenSubject(`Bearer ${jwtWith({ sub: 'user_abc', exp: 0 })}`)).toBe('user_abc');
    expect(bearerTokenSubject(`bearer ${jwtWith({ sub: ' user_abc ' })}`)).toBe('user_abc');
  });

  it('answers null for anything that is not a bearer JWT with a subject', () => {
    expect(bearerTokenSubject(undefined)).toBeNull();
    expect(bearerTokenSubject('')).toBeNull();
    expect(bearerTokenSubject('Basic abc')).toBeNull();
    expect(bearerTokenSubject('Bearer')).toBeNull();
    expect(bearerTokenSubject('Bearer not.a.jwt.at.all')).toBeNull();
    expect(bearerTokenSubject('Bearer a.b')).toBeNull();
    expect(bearerTokenSubject('Bearer a.!!!.c')).toBeNull();
    expect(bearerTokenSubject(`Bearer ${jwtWith({ exp: 0 })}`)).toBeNull();
    expect(bearerTokenSubject(`Bearer ${jwtWith({ sub: '' })}`)).toBeNull();
    expect(bearerTokenSubject(`Bearer ${jwtWith({ sub: 42 })}`)).toBeNull();
    expect(bearerTokenSubject(`Bearer ${jwtWith('a string payload')}`)).toBeNull();
  });

  it('takes the first value of a repeated header', () => {
    expect(bearerTokenSubject([`Bearer ${jwtWith({ sub: 'first' })}`, `Bearer ${jwtWith({ sub: 'second' })}`])).toBe('first');
  });
});

describe('apiRateLimitKey (#1395)', () => {
  const proxyAddress = '10.89.0.5';

  it('gives two people behind one proxy two buckets', () => {
    const a = apiRateLimitKey(`Bearer ${jwtWith({ sub: 'user_a' })}`, proxyAddress);
    const b = apiRateLimitKey(`Bearer ${jwtWith({ sub: 'user_b' })}`, proxyAddress);
    expect(a).toBe('user:user_a');
    expect(b).toBe('user:user_b');
    expect(a).not.toBe(b);
  });

  it('gives one person one bucket from any address', () => {
    const token = `Bearer ${jwtWith({ sub: 'user_a' })}`;
    expect(apiRateLimitKey(token, '203.0.113.1')).toBe(apiRateLimitKey(token, '198.51.100.7'));
  });

  it('falls back to the address for unauthenticated or unreadable requests', () => {
    expect(apiRateLimitKey(undefined, proxyAddress)).toBe(`ip:${proxyAddress}`);
    expect(apiRateLimitKey('Bearer garbage', proxyAddress)).toBe(`ip:${proxyAddress}`);
  });

  it('never lets a subject collide with an address', () => {
    expect(apiRateLimitKey(`Bearer ${jwtWith({ sub: proxyAddress })}`, proxyAddress)).not.toBe(apiRateLimitKey(undefined, proxyAddress));
  });
});
