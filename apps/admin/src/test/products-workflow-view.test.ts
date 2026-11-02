import { describe, expect, it } from 'vitest';
import {
  billingMode, pendingOneOffCount, saveAndPayEnabled, saveAndPayTarget, withoutZeroRows, psStatusKey,
} from '@/app/[locale]/members/productsWorkflowView';

const set = (status: string, expired = false) => ({ id: 1, status, version: 1, plan_name: null, starts_at: null, ends_at: null, created_at: null, created_by: null, expired });
const changed = { changes: [{}], amount_due: 10 };

describe('#1613 products workflow', () => {
  it('shows the persisted ledger when nothing affects billing', () => {
    expect(billingMode({ current: null, review: null, pendingOneOffs: 0 })).toBe('events');
    expect(billingMode({ current: set('active'), review: null, pendingOneOffs: 0 })).toBe('events');
    // an opened-but-unchanged Draft is a dirty form, not a billing change
    expect(billingMode({ current: set('draft'), review: { changes: [], amount_due: 0 }, pendingOneOffs: 0 })).toBe('events');
  });
  it('switches to simulation on a billing-affecting change or a pending one-off', () => {
    expect(billingMode({ current: set('draft'), review: changed, pendingOneOffs: 0 })).toBe('simulation');
    expect(billingMode({ current: set('active'), review: null, pendingOneOffs: 1 })).toBe('simulation');
    expect(billingMode({ current: set('pending_payment'), review: null, pendingOneOffs: 0 })).toBe('simulation');
    expect(billingMode({ current: set('draft', true), review: changed, pendingOneOffs: 0 })).toBe('events');
  });
  it('enables Save & Pay by the same pending state and respects write access', () => {
    const w = { current: set('draft'), review: changed, pendingOneOffs: 0 };
    expect(saveAndPayEnabled({ ...w, canWrite: true })).toBe(true);
    expect(saveAndPayEnabled({ ...w, canWrite: false })).toBe(false);
    expect(saveAndPayEnabled({ current: set('active'), review: null, pendingOneOffs: 0, canWrite: true })).toBe(false);
  });
  it('routes a lone one-off to its own payment link', () => {
    expect(saveAndPayTarget({ current: set('active'), review: null, pendingOneOffs: 1 })).toBe('purchases');
    expect(saveAndPayTarget({ current: set('draft'), review: changed, pendingOneOffs: 1 })).toBe('review');
  });
  it('counts only purchases awaiting payment', () => {
    expect(pendingOneOffCount([{ status: 'pending_payment' }, { status: 'active' }])).toBe(1);
  });
  it('hides zero rows for display without touching totals or the input', () => {
    const sim = { total: 5, dates: [
      { total: 5, lines: [{ actual_charge: 5 }, { actual_charge: 0 }] },
      { total: 0, lines: [{ actual_charge: 0 }] },
    ] };
    const out = withoutZeroRows(sim, true)!;
    expect(out.dates).toHaveLength(1);
    expect(out.dates[0].lines).toHaveLength(1);
    expect(out.total).toBe(5);
    expect(sim.dates).toHaveLength(2);
    expect(withoutZeroRows(sim, false)).toBe(sim);
  });
  it('maps only known statuses to a label key', () => {
    expect(psStatusKey(set('active'))).toBe('active');
    expect(psStatusKey(set('weird'))).toBeNull();
    // #2264 — an Active version with no plan and no Products is None.
    expect(psStatusKey({ ...set('active'), plan_name: null } as any, true)).toBeNull();
    expect(psStatusKey({ ...set('active'), plan_name: 'Gold' } as any, true)).toBe('active');
    expect(psStatusKey({ ...set('active'), plan_name: null } as any, false)).toBe('active');
    expect(psStatusKey(null)).toBeNull();
  });
});
