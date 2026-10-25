import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #2092 — Save Changes on the Billing & Duration editor validates the Direct
// Discount before the first request, so an invalid value cannot leave the
// assignment half saved (billing-duration written, fee-benefit refused).
// Source scan, like assigned-plan-configuration.test.ts: apps/admin has no
// component-test infra.

const SOURCE = readFileSync(
  join(__dirname, '..', 'components', 'assignedPlan', 'AssignedPlanConfiguration.tsx'), 'utf8',
);

describe('saveDuration validation order (#2092)', () => {
  const body = SOURCE.slice(SOURCE.indexOf('async function saveDuration'), SOURCE.indexOf('async function saveFeeBenefit'));

  it('checks the direct discount before any request is sent', () => {
    const check = body.indexOf('direct_discount_invalid');
    const firstRequest = body.indexOf('apiFetch(');
    expect(check).toBeGreaterThan(-1);
    expect(firstRequest).toBeGreaterThan(-1);
    expect(check).toBeLessThan(firstRequest);
  });

  it('does not start saving before the validation passes', () => {
    expect(body.indexOf('direct_discount_invalid')).toBeLessThan(body.indexOf('setSaving(true)'));
  });
});
