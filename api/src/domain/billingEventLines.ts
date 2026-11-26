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

import { type BenefitDuration, type FeeChargeSplit, type LineSource, type SimulationBenefit, type SimulationLine } from './billingSimulation';

export interface BillingEventLineRow {
  kind: 'membership_fee' | 'product' | 'service' | 'adjustment';
  /**
   * #3254 — `plan` or `product`, the origin the engine's builder gave the line (`lineSource()`);
   * `null` where neither applies. Persisted once with the line and never rewritten.
   */
  source: LineSource | null;
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
  /**
   * #2883 — the Pre-paid periods a Membership Fee line collects up front, and the cadence they are
   * counted in, so a breakdown read before the charge is written (the Initial Payment) can say
   * "2 months pre-payment". Carried, never persisted: `billing_event_lines` has no such column.
   */
  prepaid_periods?: number | null;
  prepaid_cadence?: { interval: number; unit: string } | null;
  /** #2970 — a Membership Fee's prorated stretch and prepaid periods kept apart; carried, never persisted. */
  fee_split?: FeeChargeSplit | null;
  /**
   * #3284 — every treatment that explains the line's amount, in the order the engine applied them
   * (`lineReasons()`); persisted one row each in `billing_event_line_reasons`. The `treatment_*` /
   * `promotion_name` columns above stay the line's single primary treatment for older readers.
   */
  reasons: LineReason[];
  /**
   * #3284 stage 2 — the line's stable identity in an Initial Payment (`initialPaymentLineKeys()`),
   * the target of the per-line waive; persisted as `billing_event_lines.line_key` on the initial
   * event. Absent on a scheduled obligation's line.
   */
  line_key?: string | null;
  /** #3284 stage 2 — the staff Initial Payment waive applies to this line (carried, not persisted). */
  waived?: boolean;
  /** #3284 stage 2 — the line may be waived (a positive amount, no Pre-paid Duration); carried. */
  waivable?: boolean;
  /** #3284 stage 3 — why Waive is disabled on this line (`waiveRefusal()`'s code), `null` when it is not; carried. */
  waive_refusal?: 'nothing_to_waive' | 'prepaid_fee' | null;
  /**
   * #3282 stage 3 — on a waived line, the cart's own final price the waiver set to zero (VAT
   * included), so the Initial Payment can still state its Price; carried, never persisted.
   */
  price_before_waive?: number | null;
  /**
   * #3445 stage 2 — the schedule and period of the obligation this line bills, persisted as
   * `billing_event_lines.schedule_id` / `period_start` / `period_end` by `materialiseScheduledEvents()`,
   * so a Scheduled Billing Event consolidating several schedules' lines keeps each one's identity.
   * Absent on every other line.
   */
  schedule_id?: number | null;
  period_start?: string | null;
  period_end?: string | null;
}

/**
 * #3284 — what a reason is to the person reading the line: `benefit` (the Membership Plan's own
 * configured treatment), `discount` (an applied Promotion) or `manual_adjustment` (a Direct
 * Discount (%), the Personal Membership Fee Benefit; stage 2 adds the Initial Payment waive).
 */
export const LINE_REASON_TYPES = ['benefit', 'discount', 'manual_adjustment'] as const;
export type LineReasonType = (typeof LINE_REASON_TYPES)[number];

/** Where a reason came from: the engine's own `SimulationBenefit.source`. */
export const LINE_REASON_SOURCES = ['membership_plan', 'promotion', 'personal'] as const;
export type LineReasonSource = (typeof LINE_REASON_SOURCES)[number];

export interface LineReason {
  type: LineReasonType;
  source: LineReasonSource;
  /** The explicit evidence of a manual adjustment (`direct_discount`, `personal_fee_benefit`); else `null`. */
  code: string | null;
  action: string;
  value: number | null;
  /** A Promotion's name; `null` for a Plan benefit or a manual adjustment (the line names the item). */
  name: string | null;
  /**
   * #3282 — how long that Promotion lasts (`SimulationBenefit.duration`), read as `(3 months)` beside
   * its name. Absent for every other reason and for a Promotion reason with no duration.
   */
  duration?: BenefitDuration | null;
}

export const roundCents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The benefit that explains the line's price, if any: a promotion first — unless another benefit
 * takes the line to nothing on its own (a Waive, or a 100% discount). The engine folds every
 * benefit over the line (`resolveCoveredCharge()`), so once one of them leaves nothing to charge
 * the rest discount nothing, and naming a 50% Promotion beside a €0.00 line reports a waiver it
 * did not give (#3282).
 */
export function primaryBenefit(benefits: readonly SimulationBenefit[]): SimulationBenefit | null {
  return benefits.find(takesLineToZero)
    ?? benefits.find((b) => b.source === 'promotion') ?? benefits[0] ?? null;
}

function takesLineToZero(b: SimulationBenefit): boolean {
  return b.action === 'waive' || b.action === 'included'
    || (b.action === 'percentage_discount' && Number(b.value) >= 100);
}

/**
 * #3284 — the one place a treatment is classified: by the engine's `source` and the explicit `code`,
 * never by the action or the amount (a `waive` is a Benefit or a Discount depending on where it came
 * from, and a Promotion's percentage stays a Discount). A treatment that changes nothing
 * (`no_benefit`) and a Pre-paid period's coverage (money collected earlier, not a reduction) are
 * not reasons. Order is the engine's order of application.
 */
export function lineReasons(benefits: readonly SimulationBenefit[]): LineReason[] {
  const out: LineReason[] = [];
  for (const b of benefits) {
    if (b.action === 'no_benefit' || b.period_status === 'prepaid_plan') continue;
    const type: LineReasonType = b.source === 'promotion' ? 'discount'
      : b.source === 'personal' ? 'manual_adjustment' : 'benefit';
    out.push({
      type, source: b.source,
      code: type === 'manual_adjustment' ? b.code ?? null : null,
      action: b.action === 'included' ? 'waive' : b.action,
      value: b.value != null ? Number(b.value) : null,
      name: b.source === 'promotion' ? b.name ?? null : null,
      ...(b.source === 'promotion' && b.duration ? { duration: b.duration } : {}),
    });
  }
  return out;
}

export interface LineContext {
  /** Optional proration evidence for a partial first period. */
  proration?: { proratedDays: number; periodDays: number; amount: number } | null;
  taxRatePercent?: number | null;
  taxBehavior?: string | null;
  amountExclTax?: number | null;
}

/**
 * #3254 — the one place a line's source is read: the builder's own tag, and a Membership Fee is the
 * Plan's by definition. A line no builder tagged is `null` rather than a guess.
 */
export function lineSource(line: Pick<SimulationLine, 'kind' | 'source'>): LineSource | null {
  return line.source ?? (line.kind === 'membership_fee' ? 'plan' : null);
}

export function lineFromSimulation(line: SimulationLine, ctx: LineContext = {}): BillingEventLineRow {
  const benefit = primaryBenefit(line.benefits);
  // #1867 stage 4: the engine's own prorated line carries its evidence.
  if (!ctx.proration && line.proration) {
    ctx = { ...ctx, proration: {
      proratedDays: line.proration.prorated_days, periodDays: line.proration.period_days, amount: line.actual_charge,
    } };
  }
  return {
    kind: line.kind,
    source: lineSource(line),
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
    prepaid_periods: line.prepaid_periods ?? null,
    prepaid_cadence: line.prepaid_cadence ?? null,
    fee_split: line.fee_split ?? null,
    reasons: lineReasons(line.benefits),
  };
}

export function linesTotal(lines: readonly { amount: number }[]): number {
  return roundCents(lines.reduce((sum, l) => sum + roundCents(l.amount), 0));
}

/** `true` when the persisted lines add up to the event amount to the cent. */
export function linesMatchTotal(lines: readonly { amount: number }[], eventAmount: number): boolean {
  return Math.round(linesTotal(lines) * 100) === Math.round(roundCents(eventAmount) * 100);
}
