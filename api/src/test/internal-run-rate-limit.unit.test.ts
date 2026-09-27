// Unit tests for domain/internalRunRateLimit.ts (#783).
// Pure env parsing — no DB, no HTTP.
import { describe, expect, it } from 'vitest';
import {
  INTERNAL_RUN_RATE_LIMIT_DEFAULT_MAX,
  INTERNAL_RUN_RATE_LIMIT_DEFAULT_WINDOW_MINUTES,
  internalRunRateLimitConfig,
  spendsInternalRunBudget,
} from '../domain/internalRunRateLimit';

const MINUTE = 60 * 1000;

describe('internalRunRateLimitConfig', () => {
  it('defaults to 10 failed attempts per 15 minutes', () => {
    expect(INTERNAL_RUN_RATE_LIMIT_DEFAULT_MAX).toBe(10);
    expect(INTERNAL_RUN_RATE_LIMIT_DEFAULT_WINDOW_MINUTES).toBe(15);
    expect(internalRunRateLimitConfig({})).toEqual({ limit: 10, windowMs: 15 * MINUTE });
  });

  it('reads both values from the environment', () => {
    expect(
      internalRunRateLimitConfig({
        INTERNAL_RUN_RATE_LIMIT_MAX: '3',
        INTERNAL_RUN_RATE_LIMIT_WINDOW_MINUTES: '60',
      }),
    ).toEqual({ limit: 3, windowMs: 60 * MINUTE });
  });

  it('floors a fractional value', () => {
    expect(
      internalRunRateLimitConfig({
        INTERNAL_RUN_RATE_LIMIT_MAX: '4.9',
        INTERNAL_RUN_RATE_LIMIT_WINDOW_MINUTES: '2.5',
      }),
    ).toEqual({ limit: 4, windowMs: 2 * MINUTE });
  });

  // A 0 limit would refuse the nightly run itself; a 0 window would disable
  // the limiter. Neither is honoured.
  it.each(['0', '-5', '0.5', 'abc', '', '   ', 'NaN', 'Infinity'])(
    'falls back to the defaults for %j',
    (raw) => {
      expect(
        internalRunRateLimitConfig({
          INTERNAL_RUN_RATE_LIMIT_MAX: raw,
          INTERNAL_RUN_RATE_LIMIT_WINDOW_MINUTES: raw,
        }),
      ).toEqual({ limit: 10, windowMs: 15 * MINUTE });
    },
  );

  it('falls back per variable, not all-or-nothing', () => {
    expect(
      internalRunRateLimitConfig({
        INTERNAL_RUN_RATE_LIMIT_MAX: 'nope',
        INTERNAL_RUN_RATE_LIMIT_WINDOW_MINUTES: '5',
      }),
    ).toEqual({ limit: 10, windowMs: 5 * MINUTE });
  });
});

describe('spendsInternalRunBudget', () => {
  it('only a 401 (a wrong or missing secret) spends the budget', () => {
    expect(spendsInternalRunBudget(401)).toBe(true);
  });

  // 200 = a run (or already_completed_today), 429 = the run guard's in_progress
  // or the limiter's own refusal, 500 = a crashed run. None is a guess at the
  // secret, so #781's two daily attempts can never lock the workflow out.
  it.each([200, 400, 403, 404, 429, 500, 503])('%i does not', (status) => {
    expect(spendsInternalRunBudget(status)).toBe(false);
  });
});
