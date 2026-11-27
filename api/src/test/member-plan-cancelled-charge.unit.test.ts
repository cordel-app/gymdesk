import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planShowsCharge } from '../../../apps/member/src/lib/memberProducts';

// #3501 — a Members App plan card shows no charge for a plan that will generate none.

describe('planShowsCharge', () => {
  it('hides the charge of a Cancelled or Cancels at End Date plan', () => {
    expect(planShowsCharge('cancelled')).toBe(false);
    expect(planShowsCharge('cancels_on_end_date')).toBe(false);
    expect(planShowsCharge('active_cancel_at_period_end')).toBe(false);
  });

  it('keeps the charge of every other status', () => {
    for (const s of ['active', 'paused', 'pending_payment', 'in_cart', 'draft', 'to_be_canceled', 'expired', null, undefined]) {
      expect(planShowsCharge(s as any)).toBe(true);
    }
  });

  it('the plan card omits price and frequency (no `—`, no 0 €) when told to', () => {
    const src = readFileSync(join(__dirname, '../../../apps/member/src/components/MemberPlanCatalogue.tsx'), 'utf8');
    expect(src).toContain("{item.showCharge !== false && <span style={styles.price}>");
    expect(src).toContain('{item.showCharge !== false && item.frequency &&');
  });

  it('both held-plan cards on My Products ask that one rule', () => {
    const page = readFileSync(join(__dirname, '../../../apps/member/src/app/[locale]/membership/page.tsx'), 'utf8');
    expect(page.match(/showCharge: planShowsCharge\(status\)/g)?.length).toBe(2);
  });
});
