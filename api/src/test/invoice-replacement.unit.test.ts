// #2648 stage 7 — the pure half of a complete invoice issued in place of a
// simplified one: which simplified invoice it replaces, its TipoFactura (F3),
// the FacturasSustituidas block and the Anulación refusal of a replaced invoice.
import { describe, expect, it } from 'vitest';
import { replacementTarget, type EventInvoiceState } from '../domain/billingInvoice';
import { verifactuInvoiceKind } from '../domain/verifactu';
import { anulacionRefusal } from '../domain/verifactuRecords';
import { buildRegFactuRequest, validateAltaSubmission, type AltaSubmission } from '../domain/verifactuXml';

const inv = (o: Partial<EventInvoiceState> & { id: number }): EventInvoiceState => ({
  invoiceType: 'simplified', status: 'issued', relatedInvoiceId: null, replacesInvoiceId: null, hasAnulacion: false, ...o,
});

describe('replacementTarget', () => {
  it('replaces the standing simplified invoice', () => {
    expect(replacementTarget([inv({ id: 4 })])).toBe(4);
  });
  it('replaces nothing when the event has no simplified invoice', () => {
    expect(replacementTarget([])).toBeNull();
    expect(replacementTarget([inv({ id: 1, invoiceType: 'full' })])).toBeNull();
  });
  it('never replaces a rectified, rectifying, already replaced, cancelled or draft simplified invoice', () => {
    expect(replacementTarget([inv({ id: 1 }), inv({ id: 2, relatedInvoiceId: 1 })])).toBeNull();
    expect(replacementTarget([inv({ id: 1 }), inv({ id: 2, invoiceType: 'full', replacesInvoiceId: 1 })])).toBeNull();
    expect(replacementTarget([inv({ id: 1, hasAnulacion: true })])).toBeNull();
    expect(replacementTarget([inv({ id: 1, status: 'draft' })])).toBeNull();
  });
  it('takes the oldest standing one when there are several', () => {
    expect(replacementTarget([inv({ id: 9 }), inv({ id: 3 })])).toBe(3);
  });
});

describe('TipoFactura of a replacement', () => {
  it('is F3 for a full invoice replacing a simplified one, F1 otherwise', () => {
    expect(verifactuInvoiceKind('full', null, true)).toBe('F3');
    expect(verifactuInvoiceKind('full', null)).toBe('F1');
    expect(verifactuInvoiceKind('simplified', null, true)).toBe('F2');
    // Rectifying the replacement is an ordinary R1.
    expect(verifactuInvoiceKind('full', { invoiceType: 'full' }, true)).toBe('R1');
  });
});

describe('Anulación of a replaced simplified invoice', () => {
  it('is refused', () => {
    expect(anulacionRefusal({
      integrationEnabled: true, alta: { submissionStatus: 'accepted' }, hasAnulacion: false, isRectified: false, isReplaced: true,
    })).toBe('verifactu_invoice_replaced');
  });
});

describe('FacturasSustituidas', () => {
  const f3: AltaSubmission = {
    recordId: 2, issuerNif: '12345678Z', issuerName: 'Gym', invoiceNumber: 'F-2026-0001', issueDate: '15-11-2026',
    invoiceKind: 'F3', rectified: null, replaced: { invoiceNumber: 'S-2026-0001', issueDate: '12-11-2026' },
    description: 'Membership fee', recipient: { name: 'ACME SL', nif: 'B12345678' },
    desglose: [{ rate: 21, base: 24.79, tax: 5.2 }], taxTotal: '5.20', total: '29.99',
    previous: null, generatedAt: '2026-11-15T10:00:00+01:00', hash: 'A'.repeat(64), installationNumber: 'gym-1',
  };
  it('names the replaced simplified invoice after TipoFactura', () => {
    expect(validateAltaSubmission(f3)).toEqual([]);
    const xml = buildRegFactuRequest({
      taxpayer: { name: 'Gym', nif: '12345678Z' }, incident: false,
      software: { producerName: 'Cordel Tech SL', producerNif: 'B12345678', name: 'Cordel Fitness', id: 'CF', version: '1.0' },
      records: [f3],
    });
    expect(xml).toContain('<sum1:TipoFactura>F3</sum1:TipoFactura><sum1:FacturasSustituidas><sum1:IDFacturaSustituida><sum1:IDEmisorFactura>12345678Z</sum1:IDEmisorFactura><sum1:NumSerieFactura>S-2026-0001</sum1:NumSerieFactura><sum1:FechaExpedicionFactura>12-11-2026</sum1:FechaExpedicionFactura>');
    expect(xml).toContain('<sum1:Destinatarios>');
  });
  it('refuses an F3 naming nothing, a recipient-less F3 and FacturasSustituidas on another kind', () => {
    expect(validateAltaSubmission({ ...f3, replaced: null })).toContain(
      'a replacement invoice (F3) must name the simplified invoice it replaces');
    expect(validateAltaSubmission({ ...f3, recipient: null })).toContain(
      'a full invoice must identify its recipient (Destinatarios)');
    expect(validateAltaSubmission({ ...f3, invoiceKind: 'F1' })).toContain('only an F3 invoice carries FacturasSustituidas');
  });
});

// #3298 stage 3/4 — the invoice a completed refund rectifies, and what it states.
import { refundRectificationTarget, refundRectificationLines, rectifiableRemainderCents, invoiceLineTaxes } from '../domain/billingInvoice';
describe('refundRectificationTarget', () => {
  const inv = (o: Partial<EventInvoiceState> & { id: number }): EventInvoiceState => ({
    invoiceType: 'simplified', status: 'issued', relatedInvoiceId: null, replacesInvoiceId: null, hasAnulacion: false, ...o,
  });
  it('rectifies the standing simplified invoice, whatever the refund\'s size', () => {
    expect(refundRectificationTarget([inv({ id: 1 })], 4000)).toEqual({ invoiceId: 1 });
  });
  it('keeps rectifying an invoice by differences until its refunds reach its total', () => {
    const partial = inv({ id: 2, relatedInvoiceId: 1, refundCents: 1500 });
    expect(refundRectificationTarget([inv({ id: 1 }), partial], 4000)).toEqual({ invoiceId: 1 });
    const rest = inv({ id: 3, relatedInvoiceId: 1, refundCents: 2500 });
    expect(refundRectificationTarget([inv({ id: 1 }), partial, rest], 4000)).toEqual({ skip: 'no_standing_invoice' });
  });
  it('rectifies the complete invoice that replaced a simplified one', () => {
    expect(refundRectificationTarget([inv({ id: 1 }), inv({ id: 2, invoiceType: 'full', replacesInvoiceId: 1 })], 4000))
      .toEqual({ invoiceId: 2 });
  });
  it('has no target when the invoice was cancelled in full, by Anulación, or is absent', () => {
    expect(refundRectificationTarget([inv({ id: 1 }), inv({ id: 2, relatedInvoiceId: 1 })], 4000))
      .toEqual({ skip: 'no_standing_invoice' });
    expect(refundRectificationTarget([inv({ id: 1, hasAnulacion: true })], 4000)).toEqual({ skip: 'no_standing_invoice' });
    expect(refundRectificationTarget([inv({ id: 1, status: 'draft' })], 4000)).toEqual({ skip: 'no_standing_invoice' });
    expect(refundRectificationTarget([], 4000)).toEqual({ skip: 'no_standing_invoice' });
  });
  it('a manual rectification leaves nothing to rectify', () => {
    expect(rectifiableRemainderCents(1, 4000, [inv({ id: 2, relatedInvoiceId: 1, refundCents: 1000 }), inv({ id: 3, relatedInvoiceId: 1 })])).toBe(0);
    expect(rectifiableRemainderCents(1, 4000, [inv({ id: 2, relatedInvoiceId: 1, refundCents: 1000 })])).toBe(3000);
  });
});

describe('refundRectificationLines', () => {
  const line = (name: string, amount: number, taxRate: number | null = 21) =>
    ({ name, quantity: 1, amount, amountExclTax: null, taxRate });
  const fee = line('Membership fee', 30);
  const locker = line('Locker', 10, 10);
  it('states a full refund\'s lines unchanged', () => {
    expect(refundRectificationLines([fee, locker], 40)).toEqual([fee, locker]);
  });
  it('spreads a partial amount over the lines in proportion, to the cent, keeping each rate', () => {
    const out = refundRectificationLines([fee, locker], 15);
    expect(out.map((l) => [l.name, l.amount, l.taxRate])).toEqual([['Membership fee', 11.25, 21], ['Locker', 3.75, 10]]);
    const odd = refundRectificationLines([line('A', 10), line('B', 10), line('C', 10)], 10);
    expect(odd.reduce((s, l) => s + Math.round(l.amount * 100), 0)).toBe(1000);
  });
  it('states only the lines a refund named, at the amount returned on each', () => {
    const out = refundRectificationLines([fee, locker], 5, [{ index: 1, amount: 5 }]);
    expect(out).toEqual([{ ...locker, amount: 5 }]);
  });
  it('scales a stored net with its amount', () => {
    const out = refundRectificationLines([{ ...fee, amountExclTax: 24.79 }], 15);
    expect(out[0].amountExclTax).toBe(12.4);
  });
  it('reconciles to the refund amount once taxed', () => {
    const { totals } = invoiceLineTaxes(refundRectificationLines([fee, locker], 15), 15, 21);
    expect(totals.total).toBe(15);
    expect(Math.round((totals.net + totals.tax) * 100)).toBe(1500);
  });
});
