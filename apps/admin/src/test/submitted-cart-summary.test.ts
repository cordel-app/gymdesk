import { describe, expect, it } from 'vitest';
import { submittedCartNoteKey, submittedCartView } from '@/app/[locale]/members/productsWorkflowView';

// #3307 — after Save & Pay the Summary keeps the submitted cart on screen.
describe('#3307 submitted cart in the Summary', () => {
  it('shows nothing when nothing was submitted', () => {
    expect(submittedCartView(null, [{ id: 5, status: 'pending_payment' }])).toBeNull();
  });

  it('leaves a cart awaiting payment to the in-flight row', () => {
    expect(submittedCartView({ productSetId: 5 }, [{ id: 5, status: 'pending_payment' }])).toBe('in_flight');
  });

  it('keeps a paid or activated cart as a retained row once it left the in-flight list', () => {
    expect(submittedCartView({ productSetId: 5 }, [])).toBe('committed');
  });

  it('hides the submitted cart once a new cart is opened', () => {
    expect(submittedCartView({ productSetId: 5 }, [{ id: 9, status: 'in_cart' }])).toBeNull();
  });

  it('words only the outcomes the status does not already say', () => {
    expect(submittedCartNoteKey('paid')).toBeNull();
    expect(submittedCartNoteKey('activated')).toBeNull();
    expect(submittedCartNoteKey('awaiting')).toBeNull();
    expect(submittedCartNoteKey('pending')).toBe('pay_outcome_pending');
    expect(submittedCartNoteKey('unknown')).toBe('pay_outcome_unknown');
    expect(submittedCartNoteKey('failed')).toBe('pay_outcome_failed');
  });
});
