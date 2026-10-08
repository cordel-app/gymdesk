import { describe, it, expect } from 'vitest';
import { API_RATE_LIMIT_DEFAULT_MAX, API_RATE_LIMIT_WINDOW_MS, apiRateLimitMax } from '../domain/apiRateLimit';

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
