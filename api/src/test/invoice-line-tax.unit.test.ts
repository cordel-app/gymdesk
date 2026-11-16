// #2884 — every line of a receipt, simplified invoice or full invoice states its
// own tax rate and tax amount, and the document's totals are the sums of its
// lines: Σ line tax = tax total, net + tax = grand total.
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { invoiceLineTaxes, lineTaxRate, negateLines, type LineInput } from '../domain/billingInvoice';
import { buildDesglose } from '../domain/verifactuXml';
import { generateInvoicePdf, formatTaxRate } from '../lib/invoice-pdf';
import { generateReceiptPdf } from '../lib/receipt-pdf';

const line = (name: string, amount: number, taxRate: number | null, amountExclTax: number | null = null): LineInput =>
  ({ name, quantity: 1, amount, amountExclTax, taxRate });

const cents = (n: number) => Math.round(n * 100);

/** The text a PDF draws, from its inflated content streams (pdf-lib writes strings as hex). */
function drawnText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    try { out.push(inflateSync(pdf.subarray(start, end)).toString('latin1')); } catch { /* not flate */ }
  }
  return out.join('\n').replace(/<([0-9A-F]+)>/g, (_, h) => Buffer.from(h, 'hex').toString('latin1'));
}

describe('invoiceLineTaxes', () => {
  it('applies each line its own rate, never one rate to the whole document', () => {
    const { lines, totals } = invoiceLineTaxes(
      [line('Membership', 60.5, 21), line('Physio', 22, 10), line('Insurance', 15, 0)], 97.5, 21);
    expect(lines.map((l) => [l.rate, l.net, l.tax])).toEqual([[21, 50, 10.5], [10, 20, 2], [0, 15, 0]]);
    expect(totals).toEqual({ net: 85, tax: 12.5, total: 97.5 });
  });

  it('a 0% line states 0% and 0.00 tax', () => {
    const { lines } = invoiceLineTaxes([line('Insurance', 15, 0)], 15, 21);
    expect(lines[0]).toMatchObject({ rate: 0, net: 15, tax: 0 });
  });

  it('the totals reconcile with the lines to the cent, even when each line rounds', () => {
    const input = [line('A', 29.99, 21), line('B', 9.99, 21), line('C', 4.99, 10), line('D', 0.01, 21)];
    const total = 44.98;
    const { lines, totals } = invoiceLineTaxes(input, total, 21);
    expect(cents(totals.tax)).toBe(lines.reduce((s, l) => s + cents(l.tax), 0));
    expect(cents(totals.net)).toBe(lines.reduce((s, l) => s + cents(l.net), 0));
    expect(cents(totals.net) + cents(totals.tax)).toBe(cents(total));
    for (const l of lines) expect(cents(l.net) + cents(l.tax)).toBe(cents(l.amount));
  });

  it('uses a stored net, and the rate it implies when the line stored no rate', () => {
    expect(lineTaxRate(line('x', 110, null, 100), 21)).toBe(10);
    expect(lineTaxRate(line('x', 10, null, null), 21)).toBe(21);
    const { lines } = invoiceLineTaxes([line('x', 110, null, 100)], 110, 21);
    expect(lines[0]).toMatchObject({ rate: 10, net: 100, tax: 10 });
  });

  it('a rounding cent the lines leave lands on the largest line, so the document still reconciles', () => {
    const { lines, totals } = invoiceLineTaxes([line('A', 50, 21), line('B', 10, 21)], 60.01, 21);
    expect(totals.total).toBe(60.01);
    expect(cents(totals.net) + cents(totals.tax)).toBe(6001);
    expect(cents(totals.tax)).toBe(lines.reduce((s, l) => s + cents(l.tax), 0));
  });

  it('a rectifying invoice negates every line figure', () => {
    const { lines } = invoiceLineTaxes([line('A', 12.1, 21)], 12.1, 21);
    expect(negateLines(lines)[0]).toMatchObject({ amount: -12.1, net: -10, tax: -2.1, rate: 21 });
  });

  it('the VERI*FACTU breakdown groups the same rates the lines state', () => {
    const { lines, totals } = invoiceLineTaxes([line('A', 60.5, 21), line('B', 22, 10)], 82.5, 21);
    const d = buildDesglose(lines.map((l) => ({ amount: l.amount, taxRate: l.rate })), 21, totals);
    expect(d).toEqual([{ rate: 21, base: 50, tax: 10.5 }, { rate: 10, base: 20, tax: 2 }]);
  });
});

describe('the documents print each line\'s rate and tax', () => {
  const figures = invoiceLineTaxes([line('Membership', 60.5, 21), line('Insurance', 15, 0)], 75.5, 21);
  const gym = { name: 'Gym', legalName: 'Gym SL', cif: 'B1', fiscalAddress: null, fiscalPhone: null };

  it('formats a rate as a percentage', () => {
    expect(formatTaxRate(21)).toBe('21%');
    expect(formatTaxRate(0)).toBe('0%');
    expect(formatTaxRate(5.5)).toBe('5.5%');
  });

  it('the receipt', async () => {
    const text = drawnText(await generateReceiptPdf({
      receiptNumber: 'R-1', issuedAt: new Date('2026-11-16T00:00:00Z'), gym, memberName: 'Ana',
      ...figures, currency: 'EUR',
    }));
    for (const s of ['21%', '0%', '10.50 EUR', '0.00 EUR', '65.00 EUR', '75.50 EUR']) expect(text).toContain(s);
  });

  it('simplified and full invoices', async () => {
    for (const type of ['simplified', 'full'] as const) {
      const text = drawnText(await generateInvoicePdf({
        type, state: 'paid', lang: 'en', number: 'S-2026-0001', issuedAt: new Date(), gym,
        customer: { name: 'Ana', taxId: null, address: null }, ...figures, currency: 'EUR',
      }));
      for (const s of ['VAT %', '21%', '0%', '10.50 EUR', '0.00 EUR', '65.00 EUR', '75.50 EUR']) expect(text).toContain(s);
    }
  });
});
