// #2648 stage 2 — the lines and totals an invoice of a Billing Event states,
// read once for the places that must agree on them: the PDF
// (`billing-invoices.ts`) and the VERI*FACTU record, whose ImporteTotal and
// CuotaTotal must be the figures the invoice prints.
import type { Tx } from '../infra/db';
import {
  invoiceLineTaxes, negateLines, negateTotals, refundRectificationLines,
  type InvoiceLine, type LineInput, type TaxBreakdown,
} from '../domain/billingInvoice';

interface EventLines { ids: number[]; lines: LineInput[]; fallbackRate: number }

async function loadEventLines(
  exec: Tx, gymId: string, eventId: number, eventAmount: number, fallbackName: string,
): Promise<EventLines> {
  const { rows: taxRows } = await exec.query<any>(
    "SELECT rate_percent AS rate FROM tax_rates WHERE gym_id = ? AND is_system = 1 AND status = 'active' LIMIT 1", [gymId]);
  const fallbackRate = taxRows[0] ? parseFloat(taxRows[0].rate) : 21;
  const { rows: lineRows } = await exec.query<any>(
    `SELECT id, item_name, quantity, amount, amount_excl_tax, tax_rate_percent
       FROM billing_event_lines WHERE billing_event_id = ? AND gym_id = ? ORDER BY id`, [eventId, gymId]);
  if (!lineRows.length) {
    return { ids: [], lines: [{ name: fallbackName, quantity: 1, amount: eventAmount, amountExclTax: null, taxRate: null }], fallbackRate };
  }
  return {
    ids: lineRows.map((l: any) => Number(l.id)),
    lines: lineRows.map((l: any) => ({
      name: l.item_name, quantity: l.quantity, amount: parseFloat(l.amount),
      amountExclTax: l.amount_excl_tax == null ? null : parseFloat(l.amount_excl_tax),
      taxRate: l.tax_rate_percent == null ? null : parseFloat(l.tax_rate_percent),
    })),
    fallbackRate,
  };
}

export async function loadInvoiceFigures(
  exec: Tx, gymId: string, eventId: number, eventAmount: number, fallbackName = 'Membership',
): Promise<{ lines: InvoiceLine[]; totals: TaxBreakdown; fallbackRate: number }> {
  const { lines, fallbackRate } = await loadEventLines(exec, gymId, eventId, eventAmount, fallbackName);
  // #2884: each line carries its own rate, net and tax; the totals are their sums.
  return { ...invoiceLineTaxes(lines, eventAmount, fallbackRate), fallbackRate };
}

/** The columns of an `invoices` row the figures depend on. */
export interface InvoiceFigureSource {
  billing_event_id: number;
  related_invoice_id: number | null;
  refund_payment_request_id: number | null;
}

/**
 * #3298 stage 4 — the figures an invoice states, signed as it states them: an
 * ordinary invoice its event's; a rectifying invoice staff issued by hand the
 * event's negated (it cancels its original in full); a rectifying invoice a
 * refund issued the refund's own, negated (by differences: the lines it named,
 * or its amount spread over the event's lines, `refundRectificationLines()`).
 * The one source of the PDF, the Alta record's totals and its Desglose.
 */
export async function loadDocumentFigures(
  exec: Tx, gymId: string, inv: InvoiceFigureSource, eventAmount: number,
): Promise<{ lines: InvoiceLine[]; totals: TaxBreakdown; fallbackRate: number }> {
  if (inv.related_invoice_id == null || inv.refund_payment_request_id == null) {
    const figures = await loadInvoiceFigures(exec, gymId, inv.billing_event_id, eventAmount);
    if (inv.related_invoice_id == null) return figures;
    return { ...figures, lines: negateLines(figures.lines), totals: negateTotals(figures.totals) };
  }
  const event = await loadEventLines(exec, gymId, inv.billing_event_id, eventAmount, 'Membership');
  const { rows: refRows } = await exec.query<any>(
    "SELECT amount FROM payment_requests WHERE id = ? AND gym_id = ? AND transaction_type = 'refund'",
    [inv.refund_payment_request_id, gymId]);
  const refundAmount = parseFloat(refRows[0]?.amount ?? '0');
  const { rows: named } = await exec.query<any>(
    `SELECT billing_event_line_id, amount FROM payment_refund_lines
      WHERE payment_request_id = ? AND gym_id = ? ORDER BY id`, [inv.refund_payment_request_id, gymId]);
  const refunded = named
    .map((r: any) => ({ index: event.ids.indexOf(Number(r.billing_event_line_id)), amount: parseFloat(r.amount) }))
    .filter((r: { index: number }) => r.index >= 0);
  const lines = refundRectificationLines(event.lines, refundAmount, refunded);
  const { lines: taxed, totals } = invoiceLineTaxes(lines, refundAmount, event.fallbackRate);
  return { lines: negateLines(taxed), totals: negateTotals(totals), fallbackRate: event.fallbackRate };
}
