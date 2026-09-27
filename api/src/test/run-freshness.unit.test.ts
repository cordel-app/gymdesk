// Unit tests for domain/runFreshness.ts (#782).
// Pure decision + env-var reading — no DB, no HTTP.
import { afterEach, describe, expect, it } from 'vitest';
import {
  RUN_FRESHNESS_DEFAULT_HOURS,
  evaluateRunFreshness,
  runFreshnessThresholdHours,
} from '../domain/runFreshness';

const ENV = 'RUN_FRESHNESS_THRESHOLD_HOURS';
const HOUR = 60 * 60 * 1000;

afterEach(() => {
  delete process.env[ENV];
});

describe('runFreshnessThresholdHours', () => {
  it('defaults to 26 when unset', () => {
    expect(RUN_FRESHNESS_DEFAULT_HOURS).toBe(26);
    expect(runFreshnessThresholdHours()).toBe(26);
  });

  it('honours a configured whole number of hours', () => {
    process.env[ENV] = '30';
    expect(runFreshnessThresholdHours()).toBe(30);
  });

  it('floors a fractional value', () => {
    process.env[ENV] = '27.9';
    expect(runFreshnessThresholdHours()).toBe(27);
  });

  it.each(['', 'abc', '0', '-5', '0.5', 'Infinity'])('falls back to the default for %j', (value) => {
    process.env[ENV] = value;
    expect(runFreshnessThresholdHours()).toBe(RUN_FRESHNESS_DEFAULT_HOURS);
  });
});

describe('evaluateRunFreshness', () => {
  const now = new Date('2026-09-27T12:00:00.000Z');

  it('is stale when no run ever completed', () => {
    expect(evaluateRunFreshness(null, now, 26)).toEqual({
      last_completed_at: null,
      age_hours: null,
      stale: true,
    });
  });

  it('is stale for an invalid date', () => {
    expect(evaluateRunFreshness(new Date('nope'), now, 26).stale).toBe(true);
  });

  it('is fresh for a run that finished a few hours ago', () => {
    const finished = new Date(now.getTime() - 3.5 * HOUR);
    expect(evaluateRunFreshness(finished, now, 26)).toEqual({
      last_completed_at: finished.toISOString(),
      age_hours: 3.5,
      stale: false,
    });
  });

  it('is still fresh at exactly the threshold', () => {
    const finished = new Date(now.getTime() - 26 * HOUR);
    expect(evaluateRunFreshness(finished, now, 26)).toMatchObject({ age_hours: 26, stale: false });
  });

  it('is stale one minute past the threshold', () => {
    const finished = new Date(now.getTime() - 26 * HOUR - 60 * 1000);
    expect(evaluateRunFreshness(finished, now, 26).stale).toBe(true);
  });

  it('rounds age_hours to two decimals', () => {
    const finished = new Date(now.getTime() - HOUR / 3);
    expect(evaluateRunFreshness(finished, now, 26).age_hours).toBe(0.33);
  });

  it('reads a finished_at in the future (clock skew) as age 0, fresh', () => {
    const finished = new Date(now.getTime() + 2 * HOUR);
    expect(evaluateRunFreshness(finished, now, 26)).toMatchObject({ age_hours: 0, stale: false });
  });
});
