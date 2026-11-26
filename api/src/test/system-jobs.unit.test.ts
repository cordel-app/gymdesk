// #3471 — the job registry is the history's list, and only the billing run refuses a button.
import { describe, expect, it } from 'vitest';
import { SYSTEM_JOBS, manualRunRefusal, registryMatchesHistory } from '../domain/systemJobs';

describe('system job registry (#3471)', () => {
  it('registers exactly the jobs the history knows', () => {
    expect(registryMatchesHistory()).toBe(true);
  });

  it('every route is an internal run route', () => {
    for (const j of SYSTEM_JOBS) expect(j.path).toMatch(/^\/(billing|recurring-bookings|promotion-lifecycle|plan-allowance-renewals|assignment-lifecycle|booking-reminders)\//);
  });

  it('decides a manual start', () => {
    expect(manualRunRefusal('billing_cleanup', true)).toBeNull();
    expect(manualRunRefusal('billing_cleanup', false)).toBe('not_configured');
    expect(manualRunRefusal('billing_run', true)).toBe('manual_run_not_supported');
    expect(manualRunRefusal('drop_tables', true)).toBe('unknown_job');
  });
});
