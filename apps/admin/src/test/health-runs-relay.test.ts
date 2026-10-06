// #1166 — the decision half of the health-runs relay.
import { describe, expect, it } from 'vitest';
import {
  HEALTH_RUNS_RELAY_PATH,
  HEALTH_RUNS_RELAY_TIMEOUT_MS,
  RELAY_TIMEOUT_STATUS,
  RELAY_UNCONFIGURED_STATUS,
  RELAY_UNREACHABLE_STATUS,
  healthRunsTarget,
} from '../lib/healthRunsRelay';

describe('healthRunsTarget', () => {
  it('appends the API path to the base', () => {
    expect(healthRunsTarget('http://api:3000')).toBe('http://api:3000/health/runs');
  });

  it('tolerates trailing slashes and whitespace', () => {
    expect(healthRunsTarget(' http://api:3000// ')).toBe('http://api:3000/health/runs');
  });

  it('answers null for an unset or blank base', () => {
    expect(healthRunsTarget(undefined)).toBeNull();
    expect(healthRunsTarget(null)).toBeNull();
    expect(healthRunsTarget('   ')).toBeNull();
  });
});

describe('the relay’s own answers', () => {
  it('is served at the path Grafana is pointed at', () => {
    expect(HEALTH_RUNS_RELAY_PATH).toBe('/api/health/runs');
  });

  it('is never a 200 when it cannot ask the API', () => {
    expect([RELAY_UNCONFIGURED_STATUS, RELAY_UNREACHABLE_STATUS, RELAY_TIMEOUT_STATUS]).toEqual([500, 502, 504]);
  });

  it('waits a bounded, positive time', () => {
    expect(HEALTH_RUNS_RELAY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(HEALTH_RUNS_RELAY_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
