import { describe, expect, it } from 'vitest';
import { retainedCartNoteKey, submittedCartNoteKey, submittedCartView } from '@/app/[locale]/members/productsWorkflowView';

const paid = { purchase: { id: 30 }, product_set_id: 5 };

// #3307 — after Save & Pay the Summary keeps the submitted cart on screen; stage 2 makes the paid
// cart's visibility the server's (one hour, or until a newer cart).
describe('#3307 submitted cart in the Summary', () => {
  it('shows nothing when nothing was submitted and the server reports no paid cart', () => {
    expect(submittedCartView(null, [], null)).toBeNull();
  });

  it('leaves a cart awaiting payment to the in-flight row', () => {
    expect(submittedCartView({ productSetId: 5 }, [{ id: 5, status: 'pending_payment' }], null)).toBe('in_flight');
  });

  it('keeps the paid cart the server still reports, with or without a submission on this page', () => {
    expect(submittedCartView({ productSetId: 5 }, [], paid)).toBe('committed');
    expect(submittedCartView(null, [], paid)).toBe('committed');
  });

  it('drops the retained row once the server stops reporting it (hour elapsed or a newer cart)', () => {
    expect(submittedCartView({ productSetId: 5 }, [], null)).toBeNull();
  });

  it('hides the paid cart while a new cart is in flight', () => {
    expect(submittedCartView({ productSetId: 5 }, [{ id: 9, status: 'in_cart' }], paid)).toBeNull();
  });

  it('words only the outcomes the status does not already say', () => {
    expect(submittedCartNoteKey('paid')).toBeNull();
    expect(submittedCartNoteKey('activated')).toBeNull();
    expect(submittedCartNoteKey('awaiting')).toBeNull();
    expect(submittedCartNoteKey('pending')).toBe('pay_outcome_pending');
    expect(submittedCartNoteKey('unknown')).toBe('pay_outcome_unknown');
    expect(submittedCartNoteKey('failed')).toBe('pay_outcome_failed');
  });

  it('notes the submission only on the cart this page submitted', () => {
    const submitted = { productSetId: 5, outcome: 'pending' as const, checkoutUrl: null };
    expect(retainedCartNoteKey(submitted, paid)).toBe('pay_outcome_pending');
    expect(retainedCartNoteKey(submitted, { product_set_id: 6 })).toBeNull();
    expect(retainedCartNoteKey(null, paid)).toBeNull();
  });
});
