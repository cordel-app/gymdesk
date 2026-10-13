import { describe, expect, it } from 'vitest';
import { changeMessage, confirmAction, editableLines, recurringState } from '../app/[locale]/members/recurringProductsView';

const set = (status: string, expired = false): any => ({ id: 1, status, expired });

describe('recurring products state (#1537)', () => {
  it('shows only Active or Draft, and a pending payment reads as a Draft', () => {
    expect(recurringState(set('active'), true)).toMatchObject({ chip: 'active', canStartEdit: true, editing: false });
    expect(recurringState(set('draft'), true)).toMatchObject({ chip: 'draft', editing: true, canSaveAndPay: true, canCancel: true });
    expect(recurringState(set('pending_payment'), true)).toMatchObject({ chip: 'draft', paymentPending: true, editing: false, canSaveAndPay: true });
    expect(recurringState(null, true).chip).toBeNull();
  });

  it('offers nothing to write without access, and nothing on an expired Draft', () => {
    expect(recurringState(set('active'), false).canStartEdit).toBe(false);
    expect(recurringState(set('draft', true), true)).toMatchObject({ editing: false, canSaveAndPay: false, expired: true });
  });
});

describe('confirmation action (#1537)', () => {
  it('names the exact amount when payment is due, plain Confirm when not, and nothing when unreliable', () => {
    expect(confirmAction({ amount_due: 12.5, payment_required: true, error: null })).toEqual({ key: 'review_confirm_pay', amount: 12.5 });
    expect(confirmAction({ amount_due: 0, payment_required: false, error: null })).toEqual({ key: 'review_confirm', amount: null });
    expect(confirmAction({ amount_due: null, payment_required: false, error: 'amount_unavailable' })).toBeNull();
    expect(confirmAction(null)).toBeNull();
  });
});

describe('lines and change wording', () => {
  it('lists open services and periodical benefits, ids only for services', () => {
    const lines = editableLines({
      planBenefits: [{ productId: 1, name: 'A', category: 'periodical', quantity: 1, unitPrice: 5, billingFrequency: 'month' },
        { productId: 2, name: 'B', category: 'oneoff', quantity: 1, unitPrice: 5, billingFrequency: 'once' }],
      services: [{ id: 9, productId: 3, name: 'C', quantity: 2, unitPrice: 4, billingFrequency: 'month', endsOn: null },
        { id: 10, productId: 4, name: 'D', quantity: 1, unitPrice: 4, billingFrequency: 'month', endsOn: '2026-01-01' }],
    });
    expect(lines.map((l) => [l.name, l.serviceId])).toEqual([['A', null], ['C', 9]]);
  });

  it('maps a change to a locale key with its values', () => {
    expect(changeMessage({ kind: 'quantity_changed', line: { name: 'Towel' }, from: 1, to: 3 }))
      .toEqual({ key: 'review_change_quantity', values: { name: 'Towel', from: 1, to: 3 } });
  });
});
