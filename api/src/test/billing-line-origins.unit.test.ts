import { describe, it, expect } from 'vitest';
import { pickLineOrigin } from '../api/billing-line-origins';

const periodical = new Map<number, number[]>([[7, [70]], [8, [80, 81]]]);

describe('pickLineOrigin (#3122)', () => {
  it('names the plan snapshot for a Membership Fee line only when the set holds exactly one', () => {
    expect(pickLineOrigin({ kind: 'membership_fee', product_id: null }, [5], periodical).plan_snapshot_id).toBe(5);
    expect(pickLineOrigin({ kind: 'membership_fee', product_id: null }, [5, 6], periodical).plan_snapshot_id).toBeNull();
    expect(pickLineOrigin({ kind: 'membership_fee', product_id: null }, [], periodical).plan_snapshot_id).toBeNull();
  });
  it('names the recurring snapshot for a Product line only when it is unambiguous', () => {
    expect(pickLineOrigin({ kind: 'product', product_id: 7 }, [5], periodical).product_periodical_snapshot_id).toBe(70);
    expect(pickLineOrigin({ kind: 'product', product_id: 8 }, [5], periodical).product_periodical_snapshot_id).toBeNull();
    expect(pickLineOrigin({ kind: 'product', product_id: 9 }, [5], periodical).product_periodical_snapshot_id).toBeNull();
  });
  it('leaves adjustments without an origin', () => {
    expect(pickLineOrigin({ kind: 'adjustment', product_id: 7 }, [5], periodical))
      .toEqual({ plan_snapshot_id: null, product_periodical_snapshot_id: null });
  });
});
