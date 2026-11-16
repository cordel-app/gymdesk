// #2936 — which documents a member is offered for one payment.
import { describe, expect, it } from 'vitest';
import { memberPaymentDocuments, type InvoiceCandidate } from '../domain/memberPaymentDocuments';

const inv = (over: Partial<InvoiceCandidate>): InvoiceCandidate => ({
  id: 1, invoice_type: 'simplified', status: 'issued', fiscal_number: 'S-2026-0001',
  has_document: true, replaced: false, ...over,
});

describe('memberPaymentDocuments', () => {
  it('lists nothing for a payment with no document', () => {
    expect(memberPaymentDocuments({ billingEventId: 9, receiptNumber: null, invoices: [], refundReceipts: [] })).toEqual([]);
  });

  it('lists each existing kind once, in display order', () => {
    const docs = memberPaymentDocuments({
      billingEventId: 9,
      receiptNumber: '2026-0004',
      invoices: [inv({ id: 3 }), inv({ id: 5, invoice_type: 'full', fiscal_number: 'F-2026-0001' })],
      refundReceipts: [{ id: 7, receipt_number: 'R-2026-0001' }],
    });
    expect(docs).toEqual([
      { kind: 'receipt', id: 9, number: '2026-0004' },
      { kind: 'simplified_invoice', id: 3, number: 'S-2026-0001' },
      { kind: 'full_invoice', id: 5, number: 'F-2026-0001' },
      { kind: 'refund_receipt', id: 7, number: 'R-2026-0001' },
    ]);
  });

  it('offers only the latest of a kind', () => {
    const docs = memberPaymentDocuments({
      billingEventId: 9, receiptNumber: null,
      invoices: [inv({ id: 3 }), inv({ id: 8, fiscal_number: 'R-2026-0001' })],
      refundReceipts: [{ id: 7, receipt_number: 'R-2026-0001' }, { id: 12, receipt_number: 'R-2026-0002' }],
    });
    expect(docs).toEqual([
      { kind: 'simplified_invoice', id: 8, number: 'R-2026-0001' },
      { kind: 'refund_receipt', id: 12, number: 'R-2026-0002' },
    ]);
  });

  it('hides a replaced invoice, one with no stored document and one not issued', () => {
    const docs = memberPaymentDocuments({
      billingEventId: 9, receiptNumber: null,
      invoices: [
        inv({ id: 3, replaced: true }),
        inv({ id: 4, invoice_type: 'full', has_document: false }),
        inv({ id: 6, invoice_type: 'full', status: 'draft' }),
      ],
      refundReceipts: [],
    });
    expect(docs).toEqual([]);
  });
});
