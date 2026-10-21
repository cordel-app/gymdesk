import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #1949 — source-level gate (no DB): the cadence of a plan billed from a
// ProductSet moves only on a first Draft version, through one writer.
const src = (f: string) => readFileSync(join(__dirname, '..', 'api', f), 'utf8');

describe('Draft ProductSet billing cadence (#1949)', () => {
  const draft = src('product-set-draft.ts');
  const route = src('user-memberships.ts');

  it('setBillingCadence refuses anything but a first Draft version', () => {
    expect(draft).toContain('export async function setBillingCadence');
    expect(draft).toContain('draft.version !== 1 || draft.root_product_set_id !== draft.id');
  });

  it('validates the pair against the accepted Plan cadences', () => {
    expect(draft).toContain('isAcceptedPlanCadence(interval, unit)');
  });

  it('moves the snapshot and its own schedule together', () => {
    expect(draft).toMatch(/UPDATE product_set_plan_snapshots SET recurring_billing_interval/);
    expect(draft).toMatch(/UPDATE product_set_schedules SET cadence_interval/);
  });

  it('the billing-duration route no longer refuses the cadence outright', () => {
    expect(route).toContain('psSetBillingCadence(tx, d, req.body)');
    expect(route).not.toMatch(/cannot be changed on a plan billed from a ProductSet[^']*`, *\}\s*;\s*\n\s*\}\s*\n\s*\}\s*\n\s*const hasFee/);
  });
});
