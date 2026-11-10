import { describe, it, expect } from 'vitest';
import {
  parseCustomerInput, stampText, formatFiscalNumber, parseFiscalSeq, taxBreakdown, representationToCreate, invoiceLanguage,
} from '../domain/billingInvoice';
import { generateInvoicePdf } from '../lib/invoice-pdf';

describe('#2567 stage 3 invoice rules', () => {
  it('a full invoice needs all three customer fields', () => {
    expect(parseCustomerInput({ customer_name: 'A', customer_tax_id: 'B1', customer_address: ' ' }).ok).toBe(false);
    expect(parseCustomerInput({}).ok).toBe(false);
    const ok = parseCustomerInput({ customer_name: ' Acme ', customer_tax_id: 'B1', customer_address: 'Street 1' });
    expect(ok).toEqual({ ok: true, value: { name: 'Acme', taxId: 'B1', address: 'Street 1' } });
  });
  it('stamp is translated; unknown locale falls back to Spanish', () => {
    expect(stampText('en', 'not-paid')).toBe('NOT PAID');
    expect(stampText(invoiceLanguage('fr'), 'paid')).toBe('PAGADA');
  });
  it('numbers have their own series per type', () => {
    expect(formatFiscalNumber('simplified', 2026, 7)).toBe('S-2026-0007');
    expect(formatFiscalNumber('full', 2026, 12)).toBe('F-2026-0012');
    expect(parseFiscalSeq('F-2026-0012')).toBe(12);
  });
  it('already-paid invoices only get the paid representation', () => {
    expect(representationToCreate(true)).toBe('paid');
    expect(representationToCreate(false)).toBe('not-paid');
  });
  it('tax breakdown always totals the event amount', () => {
    const t = taxBreakdown([{ name: 'x', quantity: 1, amount: 121, amountExclTax: null, taxRate: 21 }], 121, 21);
    expect(t).toEqual({ net: 100, tax: 21, total: 121 });
  });
  it('renders a PDF for each state', async () => {
    for (const state of ['paid', 'not-paid'] as const) {
      const pdf = await generateInvoicePdf({
        type: 'full', state, lang: 'ca', number: 'F-2026-0001', issuedAt: new Date(),
        gym: { name: 'G', legalName: null, cif: 'X', fiscalAddress: null, fiscalPhone: null },
        customer: { name: 'Acme', taxId: 'B1', address: 'Carrer 1' },
        lines: [{ name: 'Fee', quantity: 1, amount: 10, amountExclTax: null, taxRate: null }],
        totals: { net: 8.26, tax: 1.74, total: 10 }, currency: 'EUR',
      });
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    }
  });
});
