// #2648 stage 2 — the lines and totals an invoice of a Billing Event states,
// read once for the two places that must agree on them: the PDF
// (`billing-invoices.ts`) and the VERI*FACTU record, whose ImporteTotal and
// CuotaTotal must be the figures the invoice prints.
import type { Tx } from '../infra/db';
import { taxBreakdown, type LineInput, type TaxBreakdown } from '../domain/billingInvoice';

export async function loadInvoiceFigures(
  exec: Tx, gymId: string, eventId: number, eventAmount: number,
): Promise<{ lines: LineInput[]; totals: TaxBreakdown; fallbackRate: number }> {
  const { rows: taxRows } = await exec.query<any>(
    "SELECT rate_percent AS rate FROM tax_rates WHERE gym_id = ? AND is_system = 1 AND status = 'active' LIMIT 1", [gymId]);
  const fallbackRate = taxRows[0] ? parseFloat(taxRows[0].rate) : 21;
  const { rows: lineRows } = await exec.query<any>(
    `SELECT item_name, quantity, amount, amount_excl_tax, tax_rate_percent
       FROM billing_event_lines WHERE billing_event_id = ? AND gym_id = ? ORDER BY id`, [eventId, gymId]);
  const lines: LineInput[] = lineRows.length
    ? lineRows.map((l: any) => ({
        name: l.item_name, quantity: l.quantity, amount: parseFloat(l.amount),
        amountExclTax: l.amount_excl_tax == null ? null : parseFloat(l.amount_excl_tax),
        taxRate: l.tax_rate_percent == null ? null : parseFloat(l.tax_rate_percent),
      }))
    : [{ name: 'Membership', quantity: 1, amount: eventAmount, amountExclTax: null, taxRate: null }];
  return { lines, totals: taxBreakdown(lines, eventAmount, fallbackRate), fallbackRate };
}
