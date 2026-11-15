// #2835 stage 1 — the Assigned Plan breakdown edited in place: which line may be
// removed, how a typed Direct Discount (%) lands on both halves of an entry,
// and how the Membership Fee's discount becomes its Personal Fee Benefit.
import { describe, expect, it } from 'vitest';
import {
  canRemoveLine,
  feeDiscountPayload,
  feeDiscountValue,
  isValidDiscountPercent,
  pairLineEntries,
  withEntryDiscount,
  withoutEntry,
} from '@/components/assignedPlan/inlineLineEdit';
import type { ProductBenefitRow } from '@/lib/benefitEditing';

const row = (over: Partial<ProductBenefitRow> = {}): ProductBenefitRow => ({
  product_id: 1, quantity: 1, product_name: 'Towel', product_type: 'fee',
  product_billing_frequency: 'month', product_status: 'active', ...over,
});

function entries() {
  const optional = row({ product_id: 1, mandatory: false, direct_discount_percent: null });
  const mandatory = row({ product_id: 2, mandatory: true, direct_discount_percent: 10 });
  return pairLineEntries(
    [{ line: 'a', row: { ...optional, final_price_incl_tax: 5 } }, { line: 'b', row: mandatory }],
    [optional, mandatory],
  );
}

describe('removing a line (§3)', () => {
  it('offers removal for an Optional line only', () => {
    expect(canRemoveLine({ mandatory: false })).toBe(true);
    expect(canRemoveLine({ mandatory: true })).toBe(false);
    // A line written before its own flag existed is Mandatory (#1184).
    expect(canRemoveLine({})).toBe(false);
  });

  it('drops an Optional entry and refuses a Mandatory one', () => {
    const e = entries();
    expect(withoutEntry(e, 0).map((x) => x.draft.product_id)).toEqual([2]);
    expect(withoutEntry(e, 1)).toBe(e);
  });
});

describe('Direct Discount (%) inline (§2)', () => {
  it('keeps the drawn row beside its draft and carries the draft discount onto it', () => {
    const e = entries();
    expect(e[1].view.direct_discount_percent).toBe(10);
    // The rest of the drawn row is untouched: prices stay the server's.
    expect(e[0].view.final_price_incl_tax).toBe(5);
  });

  it('sets the typed value on both halves of one entry only', () => {
    const e = withEntryDiscount(entries(), 0, '15');
    expect(e[0].draft.direct_discount_percent).toBe('15');
    expect(e[0].view.direct_discount_percent).toBe('15');
    expect(e[1].draft.direct_discount_percent).toBe(10);
  });

  it('refuses rows that do not pair one to one', () => {
    expect(() => pairLineEntries([{ line: 'a', row: row() }], [])).toThrow();
  });

  it('accepts empty or 0..100 and nothing else', () => {
    for (const ok of ['', null, undefined, '0', '12.5', 100]) expect(isValidDiscountPercent(ok)).toBe(true);
    for (const bad of ['-1', '101', 'abc']) expect(isValidDiscountPercent(bad)).toBe(false);
  });
});

describe("the Membership Fee's Direct Discount is its Personal Fee Benefit", () => {
  it('turns a percentage into percentage_discount and empty or 0 into no_benefit', () => {
    expect(feeDiscountPayload('20')).toEqual({ action: 'percentage_discount', value: 20 });
    expect(feeDiscountPayload('')).toEqual({ action: 'no_benefit', value: null });
    expect(feeDiscountPayload('0')).toEqual({ action: 'no_benefit', value: null });
    expect(feeDiscountPayload('150')).toBeNull();
  });

  it('reads the stored benefit back as the cell value', () => {
    expect(feeDiscountValue({ action: 'percentage_discount', value: 20 })).toBe('20');
    expect(feeDiscountValue({ action: 'no_benefit', value: null })).toBe('');
  });
});
