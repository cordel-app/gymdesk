/**
 * #2947 — the tax of each line of a ProductSet's initial charge.
 *
 * The engine prices in VAT-inclusive euros and says nothing about tax, so the
 * commit charge's lines reached the Summary (and the initial Billing Event's
 * persisted lines) with no rate and no net: every line read `—` and `0.00 €`.
 * This module decides, per line, the rate it is charged at and splits the
 * line's own final amount (after every treatment, Promotion and discount) into
 * net and tax. It prices nothing: the amount is the engine's, untouched.
 *
 * Which rate is a line's:
 *   - a Membership Fee: its plan's effective rate (`selectPlanTaxRates()`: the
 *     plan's own, else the gym's system rate);
 *   - a Product: the Product's own rate;
 *   - a one-time purchase in the cart: the rate frozen on the purchase;
 *   - anything with no rate of its own: the gym's system rate, which is what
 *     `invoiceLineTaxes()` charges such a line on the invoice, so the Summary
 *     and the document issued for the payment cannot disagree.
 * A 0% rate (exempt) stays 0% and its line carries no tax.
 *
 * Pure.
 */

import type { BillingEventLineRow } from './billingEventLines';
import { roundCents } from './billingEventLines';

export interface InitialChargeTaxRates {
  /** The gym's system rate; `null` when the gym has none. */
  system: number | null;
  /** A Membership Fee line's rate, keyed by the engine line's `user_membership_id`. */
  byFeeKey: Map<number, number | null>;
  /** A Product's own configured rate. */
  byProduct: Map<number, number | null>;
}

/** The rate a line is charged at, or `null` when nothing (not even the gym) configures one. */
export function initialLineTaxRate(
  line: { kind: string; product_id: number | null; user_membership_id?: number | null; frozen_rate?: number | null },
  rates: InitialChargeTaxRates,
): number | null {
  let own: number | null = null;
  if (line.frozen_rate != null) own = line.frozen_rate;
  else if (line.kind === 'membership_fee' && line.user_membership_id != null) own = rates.byFeeKey.get(line.user_membership_id) ?? null;
  else if (line.product_id != null) own = rates.byProduct.get(line.product_id) ?? null;
  return own ?? rates.system;
}

/** The line with its rate and net stated; a line with no rate is returned as it was. */
export function withLineTax(line: BillingEventLineRow, rate: number | null): BillingEventLineRow {
  if (rate == null || !Number.isFinite(rate)) return line;
  const amount = roundCents(Number(line.amount));
  const net = roundCents(amount / (1 + rate / 100));
  return { ...line, tax_rate_percent: rate, tax_behavior: 'inclusive', amount_excl_tax: net };
}
