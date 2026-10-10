/**
 * #1325 PR 2a — a Billing Event's persisted lines, taken from the engine.
 *
 * A line is the engine's own `SimulationLine`, restated as a row: nothing here
 * prices, discounts or taxes anything, so the persisted figures are exactly
 * what the Billing Simulation quotes and the nightly run charges. What this
 * module adds is the invariant the table cannot state itself — the lines of an
 * event sum to the event's amount **to the cent** — and the one rounding policy
 * (half away from zero at two decimals) the comparison is made under.
 *
 * Pure.
 */

import type { SimulationBenefit, SimulationLine } from './billingSimulation';

export interface BillingEventLineRow {
  kind: 'membership_fee' | 'product' | 'service' | 'adjustment';
  product_id: number | null;
  item_name: string;
  item_type: string | null;
  quantity: number;
  regular_unit_price: number;
  treatment_action: string;
  treatment_value: number | null;
  promotion_name: string | null;
  prorated_days: number | null;
  period_days: number | null;
  tax_rate_percent: number | null;
  tax_behavior: string | null;
  amount_excl_tax: number | null;
  amount: number;
}

export const roundCents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** The benefit that explains the line's price, if any: a promotion first. */
function primaryBenefit(benefits: readonly SimulationBenefit[]): SimulationBenefit | null {
  return benefits.find((b) => b.source === 'promotion') ?? benefits[0] ?? null;
}

export interface LineContext {
  /** Optional proration evidence for a partial first period. */
  proration?: { proratedDays: number; periodDays: number; amount: number } | null;
  taxRatePercent?: number | null;
  taxBehavior?: string | null;
  amountExclTax?: number | null;
}

export function lineFromSimulation(line: SimulationLine, ctx: LineContext = {}): BillingEventLineRow {
  const benefit = primaryBenefit(line.benefits);
  return {
    kind: line.kind,
    product_id: line.product_id,
    item_name: line.label,
    item_type: null,
    quantity: line.quantity,
    regular_unit_price: roundCents(line.regular_price),
    treatment_action: benefit ? String(benefit.action === 'included' ? 'waive' : benefit.action) : 'no_benefit',
    treatment_value: benefit ? benefit.value : null,
    promotion_name: benefit && benefit.source === 'promotion' ? benefit.name : null,
    prorated_days: ctx.proration ? ctx.proration.proratedDays : null,
    period_days: ctx.proration ? ctx.proration.periodDays : null,
    tax_rate_percent: ctx.taxRatePercent ?? null,
    tax_behavior: ctx.taxBehavior ?? null,
    amount_excl_tax: ctx.amountExclTax ?? null,
    amount: roundCents(ctx.proration ? ctx.proration.amount : line.actual_charge),
  };
}

export function linesTotal(lines: readonly { amount: number }[]): number {
  return roundCents(lines.reduce((sum, l) => sum + roundCents(l.amount), 0));
}

/** `true` when the persisted lines add up to the event amount to the cent. */
export function linesMatchTotal(lines: readonly { amount: number }[], eventAmount: number): boolean {
  return Math.round(linesTotal(lines) * 100) === Math.round(roundCents(eventAmount) * 100);
}
