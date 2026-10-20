import { describe, expect, it } from 'vitest';
import { diffConfigurations, recurringLinesOf } from '../domain/productSetDiff';

const svc = (productId: number, quantity: number, unitPrice = 10, endsOn: string | null = null) => ({
  id: productId, productId, name: `P${productId}`, billingFrequency: 'month', unitPrice, quantity, startsOn: '2026-01-01', endsOn,
});
const asg = (services: any[], extra: any = {}): any => ({
  planName: 'Plan', membershipFeePrice: 40, promotions: [], planBenefits: [], services, ...extra,
});

describe('diffConfigurations (#1537)', () => {
  it('treats everything as added when there is no previous configuration', () => {
    const out = diffConfigurations(null, asg([svc(1, 1)]));
    expect(out).toEqual([expect.objectContaining({ kind: 'added' })]);
  });

  it('reports added, removed, quantity and price changes and ignores ended lines', () => {
    const before = asg([svc(1, 1), svc(2, 1), svc(3, 1, 10, '2026-02-01')]);
    const after = asg([svc(1, 3), svc(4, 1), svc(2, 1, 12)]);
    const kinds = diffConfigurations(before, after).map((c) => `${c.kind}`).sort();
    expect(kinds).toEqual(['added', 'price_changed', 'quantity_changed']);
    expect(recurringLinesOf(before)).toHaveLength(2);
  });

  it('reports removals, plan and fee changes and promotions', () => {
    const before = asg([svc(1, 1)], { promotions: [{ name: 'A', revokedAt: null }] });
    const after = asg([], { planName: 'Other', membershipFeePrice: 50, promotions: [{ name: 'B', revokedAt: null }] });
    const kinds = diffConfigurations(before, after).map((c) => c.kind).sort();
    expect(kinds).toEqual(['fee_changed', 'plan_changed', 'promotion_added', 'promotion_removed', 'removed']);
  });

  it('reports nothing for an unchanged configuration', () => {
    expect(diffConfigurations(asg([svc(1, 2)]), asg([svc(1, 2)]))).toEqual([]);
  });

  it('keeps two purchases of one Product apart by their lineRef (#1865)', () => {
    const line = (id: number, lineRef: number | null, quantity = 1) => ({ ...svc(7, quantity), id, lineRef });
    const before = asg([line(10, 10), line(11, 11)]);
    // The cloned version has new ids but the same lineRef: nothing changed.
    expect(diffConfigurations(before, asg([line(20, 10), line(21, 11)]))).toEqual([]);
    // Removing one purchase reports exactly that one.
    const removed = diffConfigurations(before, asg([line(21, 11)]));
    expect(removed).toEqual([expect.objectContaining({ kind: 'removed', line: expect.objectContaining({ key: 'service-ref-10' }) })]);
    // A line that predates lineRef is still the Product's one line.
    expect(diffConfigurations(asg([line(30, null)]), asg([line(31, null, 2)]))).toEqual([
      expect.objectContaining({ kind: 'quantity_changed' }),
    ]);
  });
});
