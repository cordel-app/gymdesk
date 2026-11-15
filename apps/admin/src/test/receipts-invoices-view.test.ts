// #2806 — the Receipts & Invoices section: which documents a Billing Event
// lists, when each ⋮ menu document action is offered (#2648 stage 6), and that
// every label exists in the three locales.
import { describe, it, expect } from 'vitest';
import en from '../../locales/base/en.json';
import es from '../../locales/base/es.json';
import ca from '../../locales/base/ca.json';
import {
  DOCUMENT_KINDS, billingDocuments, documentStatusKey, documentTypeKey, fullInvoiceFormError, menuDocumentBlocks,
} from '../app/[locale]/payments/billing-events/receiptsInvoicesView';
import type { InvoiceRow } from '../app/[locale]/payments/billing-events/verifactuInvoiceView';

function invoice(over: Partial<InvoiceRow>): InvoiceRow {
  return {
    id: 1, invoice_type: 'simplified', status: 'issued', fiscal_number: 'S-2026-0001', issued_at: '2026-11-14T08:00:00Z',
    payment_status: 'paid', related_invoice_id: null, rectification_reason: null, verifactu: null, can_cancel_verifactu: false,
    ...over,
  };
}

const base = { canWrite: true, canIssueReceipt: true, receiptNumber: null as string | null, amount: '50.00' as string | null, hasFullInvoice: false };

describe('Receipts & Invoices section', () => {
  it('is named Receipts & Invoices', () => {
    expect((en as any).billing_events_page.invoices_heading).toBe('Receipts & Invoices');
  });

  it('labels the menu actions, every type, status and block reason in every locale', () => {
    const keys = [
      'generate_receipt', 'view_receipt', 'generate_full_invoice', 'invoices_empty',
      ...DOCUMENT_KINDS.map(documentTypeKey), documentStatusKey('issued')!, documentStatusKey('draft')!, documentStatusKey('replaced')!,
      'gen_blocked_exists', 'gen_blocked_not_paid', 'gen_blocked_no_amount', 'gen_blocked_read_only',
      'full_inv_name_required', 'full_inv_tax_id_required', 'full_inv_address_required',
      'col_doc_type', 'col_doc_status', 'doc_view',
    ];
    for (const locale of [en, es, ca] as any[]) {
      for (const k of keys) expect(locale.billing_events_page[k], k).toBeTruthy();
    }
    expect((en as any).billing_events_page.generate_full_invoice).toBe('Generate Complete Invoice');
    // The system issues the simplified invoice: there is no action for it any more.
    for (const locale of [en, es, ca] as any[]) expect(locale.billing_events_page.generate_simple_invoice).toBeUndefined();
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

  it('reads a simplified invoice a complete one replaced as Replaced (#2648 stage 7)', () => {
    const docs = billingDocuments({ number: null, issuedAt: null }, [
      invoice({ id: 7, replaced_by_invoice_id: 8 }),
      invoice({ id: 8, invoice_type: 'full', fiscal_number: 'F-2026-0001', replaces_invoice_id: 7 }),
    ]);
    expect(docs.map((d) => d.status)).toEqual(['replaced', 'issued']);
    expect(documentStatusKey('replaced')).toBe('doc_status_replaced');
  });

  it('offers both menu actions for a paid event with no documents', () => {
    expect(menuDocumentBlocks(base)).toEqual({ receipt: null, full: null });
  });

  it('keeps the receipt action (to view it) once issued, and blocks a second complete invoice', () => {
    expect(menuDocumentBlocks({ ...base, receiptNumber: 'R-0001', hasFullInvoice: true }))
      .toEqual({ receipt: null, full: 'gen_blocked_exists' });
  });

  it('disables the receipt until the payment is received, but still offers the complete invoice', () => {
    expect(menuDocumentBlocks({ ...base, canIssueReceipt: false })).toEqual({ receipt: 'gen_blocked_not_paid', full: null });
  });

  it('offers no complete invoice with no amount, and no writes to a read-only role', () => {
    expect(menuDocumentBlocks({ ...base, amount: '0.00' }).full).toBe('gen_blocked_no_amount');
    expect(menuDocumentBlocks({ ...base, amount: null }).full).toBe('gen_blocked_no_amount');
    expect(menuDocumentBlocks({ ...base, canWrite: false })).toEqual({ receipt: 'gen_blocked_read_only', full: 'gen_blocked_read_only' });
    // Viewing a receipt already issued is not a write.
    expect(menuDocumentBlocks({ ...base, canWrite: false, receiptNumber: 'R-0001' }).receipt).toBeNull();
  });

  it('requires the three customer fields of a full invoice', () => {
    expect(fullInvoiceFormError({ customer_name: ' ', customer_tax_id: 'B1', customer_address: 'x' })).toBe('full_inv_name_required');
    expect(fullInvoiceFormError({ customer_name: 'A', customer_tax_id: '', customer_address: 'x' })).toBe('full_inv_tax_id_required');
    expect(fullInvoiceFormError({ customer_name: 'A', customer_tax_id: 'B1', customer_address: '' })).toBe('full_inv_address_required');
    expect(fullInvoiceFormError({ customer_name: 'A', customer_tax_id: 'B1', customer_address: 'C' })).toBeNull();
  });
});
