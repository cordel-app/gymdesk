// Unit tests for domain/paymentRequestExpiry.ts (#789).
// Pure env-var reading — no DB, no HTTP.
import { afterEach, describe, expect, it } from 'vitest';
import {
  ABANDONED_REQUEST_DEFAULT_HOURS,
  ABANDONED_REQUEST_MIN_HOURS,
  abandonedRequestHours,
} from '../domain/paymentRequestExpiry';

const ENV = 'PAYMENT_REQUEST_ABANDONED_HOURS';

afterEach(() => {
  delete process.env[ENV];
});

describe('abandonedRequestHours', () => {
  it('defaults to 24 hours when nothing is configured', () => {
    expect(abandonedRequestHours()).toBe(ABANDONED_REQUEST_DEFAULT_HOURS);
    expect(ABANDONED_REQUEST_DEFAULT_HOURS).toBe(24);
  });

  it('honours a configured value', () => {
    process.env[ENV] = '48';
    expect(abandonedRequestHours()).toBe(48);
  });

  it('reads the env var per call, so a change needs no restart', () => {
    process.env[ENV] = '6';
    expect(abandonedRequestHours()).toBe(6);
    process.env[ENV] = '12';
    expect(abandonedRequestHours()).toBe(12);
  });

  it('accepts the floor exactly', () => {
    process.env[ENV] = String(ABANDONED_REQUEST_MIN_HOURS);
    expect(abandonedRequestHours()).toBe(ABANDONED_REQUEST_MIN_HOURS);
  });

  // The whole defect of #789 was a deadline shorter than a checkout takes, so a
  // deployment must not be able to configure one back.
  it.each(['0', '-5', '0.5'])('ignores %s, which is below the floor', (raw) => {
    process.env[ENV] = raw;
    expect(abandonedRequestHours()).toBe(ABANDONED_REQUEST_DEFAULT_HOURS);
  });

  it.each(['', 'soon', 'NaN'])('ignores %j, which is not a number', (raw) => {
    process.env[ENV] = raw;
    expect(abandonedRequestHours()).toBe(ABANDONED_REQUEST_DEFAULT_HOURS);
  });

  // The value is spent as MySQL's `INTERVAL ? HOUR`, which has no use for a
  // fraction — so it is floored here rather than left to the server.
  it('floors a fractional value above the floor', () => {
    process.env[ENV] = '1.9';
    expect(abandonedRequestHours()).toBe(1);
    process.env[ENV] = '36.75';
    expect(abandonedRequestHours()).toBe(36);
  });

  it('returns a whole number for every accepted input', () => {
    for (const raw of ['1', '2.5', '24', '999.999']) {
      process.env[ENV] = raw;
      expect(Number.isInteger(abandonedRequestHours())).toBe(true);
    }
  });
});
