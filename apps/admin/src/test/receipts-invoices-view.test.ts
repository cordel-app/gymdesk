// #2806 — the Receipts & Invoices section: which documents a Billing Event
// lists, when each Generate button is offered, and that every label exists in
// the three locales.
import { describe, it, expect } from 'vitest';
import en from '../../locales/base/en.json';
import es from '../../locales/base/es.json';
import ca from '../../locales/base/ca.json';
import {
  DOCUMENT_KINDS, billingDocuments, documentStatusKey, documentTypeKey, fullInvoiceFormError, generateBlocks,
} from '../app/[locale]/payments/billing-events/receiptsInvoicesView';
import type { InvoiceRow } from '../app/[locale]/payments/billing-events/verifactuInvoiceView';

function invoice(over: Partial<InvoiceRow>): InvoiceRow {
  return {
    id: 1, invoice_type: 'simplified', status: 'issued', fiscal_number: 'S-2026-0001', issued_at: '2026-11-14T08:00:00Z',
    payment_status: 'paid', related_invoice_id: null, rectification_reason: null, verifactu: null, can_cancel_verifactu: false,
    ...over,
  };
}

const base = { canWrite: true, canIssueReceipt: true, receiptNumber: null, amount: '50.00', invoices: [] as InvoiceRow[] };

describe('Receipts & Invoices section', () => {
  it('is named Receipts & Invoices', () => {
    expect((en as any).billing_events_page.invoices_heading).toBe('Receipts & Invoices');
  });

  it('labels the three buttons, every type, status and block reason in every locale', () => {
    const keys = [
      'generate_receipt', 'generate_simple_invoice', 'generate_full_invoice', 'invoices_empty',
      ...DOCUMENT_KINDS.map(documentTypeKey), documentStatusKey('issued')!, documentStatusKey('draft')!,
      'gen_blocked_exists', 'gen_blocked_not_paid', 'gen_blocked_no_amount', 'gen_blocked_read_only',
      'full_inv_name_required', 'full_inv_tax_id_required', 'full_inv_address_required',
      'col_doc_type', 'col_doc_status', 'doc_view',
    ];
    for (const locale of [en, es, ca] as any[]) {
      for (const k of keys) expect(locale.billing_events_page[k], k).toBeTruthy();
    }
    expect((en as any).billing_events_page.generate_simple_invoice).toBe('Generate Simple Invoice');
  });

  it('lists nothing when no document was generated', () => {
    expect(billingDocuments({ number: null, issuedAt: null }, [])).toEqual([]);
  });

  it('lists the receipt and every invoice, a rectifying one as its own row', () => {
    const docs = billingDocuments(
      { number: 'R-0001', issuedAt: '2026-11-14T09:00:00Z' },
      [invoice({ id: 7 }), invoice({ id: 8, invoice_type: 'full', fiscal_number: 'F-2026-0001' }),
        invoice({ id: 9, fiscal_number: 'R-2026-0001', related_invoice_id: 7 })],
    );
    expect(docs.map((d) => [d.kind, d.number, d.rectifying])).toEqual([
      ['receipt', 'R-0001', false],
      ['simplified', 'S-2026-0001', false],
      ['full', 'F-2026-0001', false],
      ['simplified', 'R-2026-0001', true],
    ]);
    expect(docs[0].invoice).toBeNull();
    expect(docs[1].invoice?.id).toBe(7);
  });

  it('offers all three buttons for a paid event with no documents', () => {
    expect(generateBlocks(base)).toEqual({ receipt: null, simplified: null, full: null });
  });

  it('does not offer a second generation of a document that exists', () => {
    const blocks = generateBlocks({ ...base, receiptNumber: 'R-0001', invoices: [invoice({})] });
    expect(blocks).toEqual({ receipt: 'gen_blocked_exists', simplified: 'gen_blocked_exists', full: null });
  });

  it('a rectifying invoice does not count as the original of its type', () => {
    const blocks = generateBlocks({ ...base, invoices: [invoice({ invoice_type: 'full', related_invoice_id: 3 })] });
    expect(blocks.full).toBeNull();
  });

  it('offers no receipt for an unpaid event, but still its invoices', () => {
    expect(generateBlocks({ ...base, canIssueReceipt: false })).toEqual({
      receipt: 'gen_blocked_not_paid', simplified: null, full: null,
    });
  });

  it('offers no invoice for an event with no amount, and nothing to a read-only role', () => {
    expect(generateBlocks({ ...base, amount: '0.00' }).simplified).toBe('gen_blocked_no_amount');
    expect(generateBlocks({ ...base, amount: null }).full).toBe('gen_blocked_no_amount');
    expect(generateBlocks({ ...base, canWrite: false })).toEqual({
      receipt: 'gen_blocked_read_only', simplified: 'gen_blocked_read_only', full: 'gen_blocked_read_only',
    });
  });

  it('requires the three customer fields of a full invoice', () => {
    expect(fullInvoiceFormError({ customer_name: ' ', customer_tax_id: 'B1', customer_address: 'x' })).toBe('full_inv_name_required');
    expect(fullInvoiceFormError({ customer_name: 'A', customer_tax_id: '', customer_address: 'x' })).toBe('full_inv_tax_id_required');
    expect(fullInvoiceFormError({ customer_name: 'A', customer_tax_id: 'B1', customer_address: '' })).toBe('full_inv_address_required');
    expect(fullInvoiceFormError({ customer_name: 'A', customer_tax_id: 'B1', customer_address: 'C' })).toBeNull();
  });
});
