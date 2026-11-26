// #2860 — the two sections of the Product Set Summary shown before Save & Pay.
//
// **Initial Payment** restates the commit charge (`commitCharge()`, the very
// lines and amount Save & Pay asks for): this module prices nothing, it only
// splits each line the engine produced into what the screen states (unit price,
// discount, tax) and adds them up, so the total is the charge to the cent.
//
// **Contracted Products & Plans** is what the Draft contracts, for whom and how
// often: names, a billing period and members only. It carries no amount on
// purpose — the issue forbids prices, discounts and taxes there, and a shape
// with no money field cannot leak one.

import type { FeeChargeSplit, LineSource } from './billingSimulation';
import { benefitDuration, type BenefitDuration } from './billingSimulation';
import { LINE_REASON_SOURCES, LINE_REASON_TYPES, type LineReason } from './billingEventLines';

/** One line of the commit charge, as `GET /product-sets/:id/review` reports it. */
export interface ChargeLineLike {
  item_name: string | null;
  quantity: number;
  /** The line's charge, VAT included. */
  amount: number;
  /**
   * The line's regular price before any treatment or Promotion, VAT included —
   * the engine's `regular_price`, which is `unit × quantity` for the **whole
   * line** despite the stored column's name (#2890); `null` when unknown.
   */
  regular_unit_price: number | null;
  promotion_name: string | null;
  treatment_action: string | null;
  treatment_value: number | null;
  tax_rate_percent: number | null;
  amount_excl_tax: number | null;
  /** #2883 — the Pre-paid periods a Membership Fee line covers, and their cadence; absent elsewhere. */
  prepaid_periods?: number | null;
  prepaid_cadence?: { interval: number; unit: string } | null;
  /** #2970 — the prorated stretch and the full prepaid periods of a Membership Fee's first charge. */
  fee_split?: FeeChargeSplit | null;
  /** #3165 stage 2 — the engine's proration of a partial first period (days charged of the period's days). */
  prorated_days?: number | null;
  period_days?: number | null;
  /** #3270 — the line's `source` (#3254: `plan` | `product`), `null` where none applies. */
  source?: LineSource | null;
  /** #3284 — every treatment that explains the amount, classified (`lineReasons()`); `[]` for none. */
  reasons?: LineReason[];
  /** #3284 stage 2 — the line's stable identity and its staff waive state; absent on a read that has none. */
  line_key?: string | null;
  waived?: boolean;
  waivable?: boolean;
  /** #3284 stage 3 — why Waive is disabled on this line; `null` when it is not. */
  waive_refusal?: WaiveRefusalCode | null;
  /** #3282 stage 3 — a waived line's In Cart final price before the waiver; absent where unknown. */
  price_before_waive?: number | null;
}

/** #3284 stage 3 — the codes a disabled Waive states (`domain/initialPaymentWaiver.ts`). */
export type WaiveRefusalCode = 'nothing_to_waive' | 'prepaid_fee';
const WAIVE_REFUSAL_CODES: readonly string[] = ['nothing_to_waive', 'prepaid_fee'];
const waiveRefusalOf = (v: unknown): WaiveRefusalCode | null =>
  typeof v === 'string' && WAIVE_REFUSAL_CODES.includes(v) ? v as WaiveRefusalCode : null;

/** #3284 — a line's reasons as a reader received them (the row shape or the stored rows), validated. */
export function lineReasonsView(raw: unknown): LineReason[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r: any) => {
    const type = r?.type ?? r?.reason_type;
    if (!(LINE_REASON_TYPES as readonly string[]).includes(type)) return [];
    if (!(LINE_REASON_SOURCES as readonly string[]).includes(r.source)) return [];
    return [{
      type, source: r.source,
      code: r.code ?? r.reason_code ?? null,
      action: String(r.action),
      value: r.value != null ? Number(r.value) : null,
      name: r.name ?? null,
      ...durationOfReason(r),
    }];
  });
}

/** #3282 — a reason's duration, from the engine's shape (`duration`) or the stored columns. */
function durationOfReason(r: any): { duration?: BenefitDuration } {
  const d = r.duration != null
    ? benefitDuration(r.duration.count, r.duration.unit)
    : benefitDuration(r.duration_count, r.duration_unit);
  return d ? { duration: d } : {};
}

/**
 * #2965 — a stored or simulated charge line (`BillingEventLineRow`) as the Summary reads it. The
 * Product Set review and the standalone cart's summary both go through it, so one line cannot be
 * read two ways.
 */
export function chargeLineView(l: any): ChargeLineLike {
  return {
    item_name: l.item_name ?? null, quantity: Number(l.quantity), amount: Number(l.amount),
    regular_unit_price: l.regular_unit_price != null ? Number(l.regular_unit_price) : null,
    promotion_name: l.promotion_name ?? null,
    treatment_action: l.treatment_action ?? null,
    treatment_value: l.treatment_value != null ? Number(l.treatment_value) : null,
    tax_rate_percent: l.tax_rate_percent != null ? Number(l.tax_rate_percent) : null,
    amount_excl_tax: l.amount_excl_tax != null ? Number(l.amount_excl_tax) : null,
    prepaid_periods: l.prepaid_periods ?? null,
    prepaid_cadence: l.prepaid_cadence ?? null,
    fee_split: l.fee_split ?? null,
    prorated_days: l.prorated_days != null ? Number(l.prorated_days) : null,
    period_days: l.period_days != null ? Number(l.period_days) : null,
    source: l.source === 'plan' || l.source === 'product' ? l.source : null,
    reasons: lineReasonsView(l.reasons),
    line_key: l.line_key ?? null,
    waived: l.waived === true,
    waivable: l.waivable === true,
    waive_refusal: waiveRefusalOf(l.waive_refusal),
    price_before_waive: l.price_before_waive != null ? Number(l.price_before_waive) : null,
  };
}

/**
 * #3165 stage 2 — the proration a line's first charge applied, as the Initial Payment states it
 * beside the item ("Prorated: 9 of 30 days"): the engine's own `prorated_days` / `period_days`,
 * and only for a genuinely partial period. A Membership Fee whose first charge is split
 * (`fee_split`, #2970) already states its prorated stretch, so it gets none here.
 */
export function lineProration(l: Pick<ChargeLineLike, 'prorated_days' | 'period_days' | 'fee_split'>):
  { days: number; period_days: number } | null {
  if (l.fee_split) return null;
  const days = l.prorated_days != null ? Number(l.prorated_days) : null;
  const period = l.period_days != null ? Number(l.period_days) : null;
  if (days == null || period == null || !(days > 0) || !(period > 0) || days >= period) return null;
  return { days, period_days: period };
}

/**
 * #3360 — the regular price a line's charge is measured against, VAT included: the engine's
 * regular price of the line (`unit × quantity`, #2890), scaled to the stretch a prorated first
 * charge covers (`lineProration()`). Proration is the period the charge is for, never a discount,
 * so a 9-of-30-days line is compared with 9/30 of its regular price. `null` when unknown.
 */
export function lineRegularTotal(
  l: Pick<ChargeLineLike, 'regular_unit_price' | 'prorated_days' | 'period_days' | 'fee_split'>,
): number | null {
  if (l.regular_unit_price == null) return null;
  const regular = Number(l.regular_unit_price);
  const p = lineProration(l);
  return p ? round2(regular * p.days / p.period_days) : round2(regular);
}

export interface InitialPaymentLine {
  name: string | null;
  quantity: number;
  /** The price of one unit for a whole period, VAT included, before discounts (its list price). */
  unit_price: number;
  /**
   * #2890 — the line before discounts (unit price × quantity), VAT included; #3360: for the
   * stretch the charge covers, so a prorated line's total is prorated too and never reads the
   * proration as a discount.
   */
  line_total: number;
  /** The line total minus the charge; 0 when nothing was taken off. */
  discount: number;
  /**
   * #3282 stage 3 — **Base Price (incl. VAT)**: quantity × the Product's base price, prorated, before
   * any discount (the same figure as `line_total`).
   */
  base_price: number;
  /**
   * #3282 stage 3 — **Price (incl. VAT)**: the cart's own final price of the line (the engine's
   * charge, every Promotion, Direct Discount and benefit already in it), with only the Initial
   * Payment proration applied. Nothing re-prices it here. A staff waiver does not change it: a
   * waived line keeps the price the waiver took to zero, and only `amount` and `tax_amount` are 0.
   */
  price: number;
  /**
   * #3381 — what one unit is actually charged, VAT included: the line's final `amount` over its
   * quantity, so it carries every discount, benefit, adjustment and the proration exactly once.
   */
  charged_unit_price: number;
  /**
   * #3381 — how a prorated line's charge is made up: `quantity × unit_price × days/period_days`,
   * where `unit_price` is one unit's full-period price after discounts and benefits. Derived from
   * the engine's `amount` and proration, never re-priced; `null` on a line that was not prorated.
   */
  charged_unit_breakdown: { quantity: number; unit_price: number; days: number; period_days: number } | null;
  /**
   * #3381 stage 2 — how `base_price` is made up, shown under it: `quantity × unit_price` and, on a
   * prorated line, `× days/period_days`, where `unit_price` is one unit's full-period price before
   * any discount (the engine's regular price of the line over its quantity). Display only: derived
   * from the figures `base_price` was taken from, never re-priced. `null` when the line has no
   * regular price, or when it is one unprorated unit (the formula would only restate the price).
   */
  base_price_breakdown: { quantity: number; unit_price: number; days: number | null; period_days: number | null } | null;
  /** What the discount is: the Promotion's name, else the line's own treatment. */
  promotion_name: string | null;
  treatment_action: string | null;
  treatment_value: number | null;
  tax_rate_percent: number | null;
  /** The VAT included in `price`; 0 on a waived line, whose amount is 0. */
  tax_amount: number;
  /** The line's final amount, VAT included: `price`, or 0 on a waived line. */
  amount: number;
  /**
   * #2883 — on the Membership Fee line that collects a Pre-paid Duration up front: how many billing
   * periods its amount covers and their cadence, kept apart from `quantity` (the number of fees).
   * `null` on every other line.
   */
  prepaid_periods: number | null;
  prepaid_cadence: { interval: number; unit: string } | null;
  /**
   * #2970 — the line's first charge in two separate parts: the prorated stretch (dates, days, amount)
   * and the N full prepaid periods (coverage, amount). VAT included; they sum to `amount`. `null`
   * unless the line has a prorated stretch.
   */
  fee_split: FeeChargeSplit | null;
  /** #3165 stage 2 — the partial first period this line's charge was prorated to (`lineProration()`). */
  proration: { days: number; period_days: number } | null;
  /**
   * #3270 — the line's `source` as the Billing Event Line carries it (#3254): `plan`, `product`, or
   * `null` for a line no source applies to. Read from the line, never inferred from its name or price.
   */
  source: LineSource | null;
  /**
   * #3284 — every treatment that explains the amount, each with its type (Benefit / Discount /
   * Manual adjustment), in the order applied: the same rows Save & Pay persists on the Billing Event
   * Line (`billing_event_line_reasons`).
   */
  reasons: LineReason[];
  /**
   * #3284 stage 2 — the line's stable identity (the target of Waive / Revert waive and the
   * `line_key` its Billing Event Line is written with), whether the staff waive applies to it, and
   * whether it could be waived. `null` / `false` on a line read without them.
   */
  line_key: string | null;
  waived: boolean;
  waivable: boolean;
  /** #3284 stage 3 — why Waive is disabled, worded beside the button; `null` when it is enabled or absent. */
  waive_refusal: WaiveRefusalCode | null;
}

export interface InitialPaymentTaxRow {
  /** `null` groups the lines that carry no tax rate. */
  rate_percent: number | null;
  base: number;
  tax: number;
}

export interface InitialPayment {
  lines: InitialPaymentLine[];
  /** #2890 / #3282 stage 3 — SUM(base_price), VAT included. */
  total_before_discounts: number;
  /** #3282 stage 3 — SUM(amount − tax_amount). */
  subtotal_excl_tax: number;
  /** #3282 stage 3 — SUM(base_price) − SUM(price); a staff waiver is not a discount. */
  discount_total: number;
  taxes: InitialPaymentTaxRow[];
  tax_total: number;
  /** The amount Save & Pay charges (`amount_due`), never a re-added figure. */
  total: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * #2890 — a charge line's unit price and its total before discounts. The
 * persisted `regular_unit_price` is the engine's regular price of the whole
 * line (`regular_price = unit × quantity`, `billingSimulation.ts`), so the unit
 * price is that divided by the quantity — never the stored figure, which read a
 * 10-unit €50 line as a €500 unit price and a −€5,000 discount. With no regular
 * price the charge itself is the line total and nothing was taken off.
 */
export function regularLinePrices(regularLinePrice: number | null, quantity: number, amount: number):
  { unit: number; lineTotal: number } {
  const lineTotal = regularLinePrice != null ? round2(Number(regularLinePrice)) : round2(amount);
  const unit = quantity > 0 ? round2(lineTotal / quantity) : lineTotal;
  return { unit, lineTotal };
}

/**
 * #3381 — a line's charge per unit and, for a prorated line, the full-period unit price after
 * discounts it was prorated from. Both are read back from the engine's own `amount` (which already
 * applied quantity, every treatment and the proration once), so nothing is priced or prorated here.
 */
export function chargedUnitPrice(
  amount: number, quantity: number, proration: { days: number; period_days: number } | null,
): { unit: number; breakdown: InitialPaymentLine['charged_unit_breakdown'] } {
  const perUnit = quantity > 0 ? amount / quantity : amount;
  if (!proration) return { unit: round2(perUnit), breakdown: null };
  return {
    unit: round2(perUnit),
    breakdown: {
      quantity,
      unit_price: round2(perUnit * proration.period_days / proration.days),
      days: proration.days,
      period_days: proration.period_days,
    },
  };
}

/**
 * #3381 stage 2 — the factors behind a line's Base Price: its quantity, one unit's full-period
 * regular price and the proration. Read back from the engine's regular price of the line
 * (`regular_unit_price` = unit × quantity, #2890), so nothing is priced here.
 */
export function basePriceBreakdown(
  regularLinePrice: number | string | null, quantity: number, proration: { days: number; period_days: number } | null,
): InitialPaymentLine['base_price_breakdown'] {
  if (regularLinePrice == null || !(quantity > 0)) return null;
  if (!proration && quantity === 1) return null;
  return {
    quantity,
    unit_price: round2(Number(regularLinePrice) / quantity),
    days: proration ? proration.days : null,
    period_days: proration ? proration.period_days : null,
  };
}

/**
 * The Initial Payment breakdown of a commit charge. `total` is `amountDue`
 * itself — the engine's lines already sum to it (`billingEventLines.ts`), so the
 * screen's total and the charge cannot disagree.
 */
export function initialPaymentBreakdown(lines: ChargeLineLike[], amountDue: number | null): InitialPayment {
  const taxes = new Map<string, InitialPaymentTaxRow>();
  const out: InitialPaymentLine[] = lines.map((l) => {
    const quantity = Number(l.quantity) || 0;
    const amount = round2(Number(l.amount));
    const net = l.amount_excl_tax != null ? round2(Number(l.amount_excl_tax)) : amount;
    const tax = round2(amount - net);
    // #3282 stage 3 — the cart's price before a staff waiver; a line read with no such figure (a
    // persisted waived line awaiting payment) states its amount.
    const price = l.waived === true && l.price_before_waive != null ? round2(Number(l.price_before_waive)) : amount;
    const { unit } = regularLinePrices(l.regular_unit_price, quantity, amount);
    const regular = lineRegularTotal(l);
    const lineTotal = regular != null ? regular : amount;
    const discount = Math.max(0, round2(lineTotal - amount));
    const proration = lineProration(l);
    const charged = chargedUnitPrice(price, quantity, proration);
    const rate = l.tax_rate_percent != null ? Number(l.tax_rate_percent) : null;
    const key = rate == null ? '' : String(rate);
    const row = taxes.get(key) ?? { rate_percent: rate, base: 0, tax: 0 };
    row.base = round2(row.base + net);
    row.tax = round2(row.tax + tax);
    taxes.set(key, row);
    return {
      name: l.item_name, quantity, unit_price: unit, line_total: lineTotal, discount,
      base_price: lineTotal, price,
      charged_unit_price: charged.unit, charged_unit_breakdown: charged.breakdown,
      base_price_breakdown: basePriceBreakdown(l.regular_unit_price, quantity, proration),
      promotion_name: l.promotion_name, treatment_action: l.treatment_action, treatment_value: l.treatment_value,
      tax_rate_percent: rate, tax_amount: tax, amount,
      prepaid_periods: l.prepaid_periods != null && l.prepaid_periods > 0 ? Number(l.prepaid_periods) : null,
      prepaid_cadence: l.prepaid_periods != null && l.prepaid_periods > 0 ? l.prepaid_cadence ?? null : null,
      fee_split: l.fee_split ?? null,
      proration,
      source: l.source ?? null,
      reasons: l.reasons ?? [],
      line_key: l.line_key ?? null,
      waived: l.waived === true,
      waivable: l.waivable === true,
      waive_refusal: l.waivable === true ? null : waiveRefusalOf(l.waive_refusal),
    };
  });
  const taxRows = [...taxes.values()]
    .filter((r) => r.rate_percent != null)
    .sort((a, b) => (a.rate_percent ?? 0) - (b.rate_percent ?? 0));
  return {
    lines: out,
    total_before_discounts: round2(out.reduce((n, l) => n + l.line_total, 0)),
    subtotal_excl_tax: round2(out.reduce((n, l) => n + (l.amount - l.tax_amount), 0)),
    discount_total: round2(out.reduce((n, l) => n + l.base_price, 0) - out.reduce((n, l) => n + l.price, 0)),
    taxes: taxRows,
    tax_total: round2(out.reduce((n, l) => n + l.tax_amount, 0)),
    total: amountDue,
  };
}

// ── Contracted Products & Plans ─────────────────────────────────────────────

export interface ContractedMember { member_id: number; name: string | null }

export interface ContractedItem {
  kind: 'plan' | 'product';
  name: string;
  /** `one_off` for a one-time Product, `recurring` for a plan or a recurring Product. */
  period: 'one_off' | 'recurring';
  /** A Product's own frequency; `null` for a plan (its period is `cadence`) or when unknown. */
  billing_frequency: string | null;
  /** A plan's billing cadence, the stored pair; `null` for a Product. */
  cadence: { interval: number; unit: string } | null;
  quantity: number | null;
  /** Who it is for; empty when it is the whole family's (a Shared line of a plan). */
  members: ContractedMember[];
  /** #3007 stage 4 — the Draft ends this item; `ends_on` is its effective end date. Not yet cancelled. */
  pending_deletion: { ends_on: string | null } | null;
  /** #3114 stage 3 — a plan this cart reactivates (no new assignment); open-ended once committed. */
  pending_reactivation: boolean;
  /** A plan's included Products, in the plan's own frozen lines. */
  included: Array<{ name: string; billing_frequency: string | null; quantity: number; members: ContractedMember[] }>;
}

export interface ContractPlanLike {
  plan_name: string | null;
  billing_interval: number | null;
  billing_unit: string | null;
  entitlement_only: boolean;
  beneficiaries: Array<{ member_id: number; name: string | null }>;
  benefits: Array<{ name: string; quantity: number; billing_frequency: string | null; assigned_member_id: number | null; member_name: string | null }>;
  pending_deletion?: boolean;
  /** #3114 stage 3 — the cart reactivates this (entitlement-only) plan, so it is contracted again. */
  pending_reactivation?: boolean;
  ends_at?: string | null;
  /** #3439 — the plan's lifecycle as the Product Set view reads it (`to_be_canceled_immediately`, …). */
  status?: string | null;
}

export interface ContractLineLike {
  product_name: string;
  quantity: number;
  billing_frequency: string | null;
  assigned_member_id: number | null;
  pending_deletion?: boolean;
  ends_at?: string | null;
}

export interface ContractPurchaseLike {
  product_name: string;
  units: number | null;
  billing_frequency: string | null;
  assigned_member_id: number | null;
  member_id: number;
}

/** A recurring frequency; `once`, `per_session` and none are a one-time Product (#945). */
const isRecurring = (f: string | null) => f != null && f !== 'once' && f !== 'per_session';

/**
 * What the Draft contracts: its plans (an entitlement-only link is a plan
 * running to its end, not contracted), its recurring lines and its one-time
 * Products, in that order. `names` resolves a member id to their name.
 */
export function contractedItems(
  input: { plans: ContractPlanLike[]; lines: ContractLineLike[]; purchases: ContractPurchaseLike[] },
  names: Map<number, string | null>,
): ContractedItem[] {
  const member = (id: number | null): ContractedMember[] =>
    id == null ? [] : [{ member_id: id, name: names.get(id) ?? null }];
  const out: ContractedItem[] = [];
  for (const p of input.plans) {
    if (p.entitlement_only && !p.pending_reactivation) continue;
    out.push({
      kind: 'plan', name: p.plan_name ?? '', period: 'recurring',
      billing_frequency: null,
      cadence: p.billing_interval != null && p.billing_unit ? { interval: Number(p.billing_interval), unit: p.billing_unit } : null,
      quantity: null,
      pending_deletion: p.pending_deletion ? { ends_on: p.ends_at ?? null } : null,
      pending_reactivation: p.pending_reactivation === true,
      members: p.beneficiaries.map((b) => ({ member_id: b.member_id, name: b.name })),
      included: p.benefits.map((b) => ({
        name: b.name, billing_frequency: b.billing_frequency, quantity: b.quantity,
        members: b.assigned_member_id == null ? [] : [{ member_id: b.assigned_member_id, name: b.member_name }],
      })),
    });
  }
  for (const l of input.lines) {
    out.push({
      kind: 'product', name: l.product_name,
      period: isRecurring(l.billing_frequency) ? 'recurring' : 'one_off',
      billing_frequency: l.billing_frequency, cadence: null, quantity: l.quantity,
      pending_deletion: l.pending_deletion ? { ends_on: l.ends_at ?? null } : null,
      pending_reactivation: false,
      members: member(l.assigned_member_id), included: [],
    });
  }
  for (const p of input.purchases) {
    out.push({
      kind: 'product', name: p.product_name, period: 'one_off',
      billing_frequency: p.billing_frequency, cadence: null, quantity: null,
      pending_deletion: null,
      pending_reactivation: false,
      members: member(p.assigned_member_id ?? p.member_id), included: [],
    });
  }
  return out;
}

/** #3439 — a plan this commit cancels today, with the Products it includes, for the Summary. */
export interface ImmediateCancellationItem {
  kind: 'plan';
  name: string;
  /** The plan's End Date once committed (today). */
  ends_on: string | null;
  /** Who the plan covers. */
  members: ContractedMember[];
  /** The plan's included Products, from its own frozen lines, nested under it. */
  included: ContractedItem['included'];
}

/**
 * #3439 — the plans marked `to_be_canceled_immediately` that the commit cancels, each with the
 * Products it includes. A separate list from `contractedItems()`: an immediate cancellation is not
 * something the Draft contracts, and its Products are the plan's, never standalone cancellations.
 * Derived from the same Product Set view; nothing is stored or priced.
 */
export function immediateCancellationItems(plans: ContractPlanLike[]): ImmediateCancellationItem[] {
  return plans
    .filter((p) => p.status === 'to_be_canceled_immediately')
    .map((p) => ({
      kind: 'plan' as const,
      name: p.plan_name ?? '',
      ends_on: p.ends_at ?? null,
      members: p.beneficiaries.map((b) => ({ member_id: b.member_id, name: b.name })),
      included: p.benefits.map((b) => ({
        name: b.name, billing_frequency: b.billing_frequency, quantity: b.quantity,
        members: b.assigned_member_id == null ? [] : [{ member_id: b.assigned_member_id, name: b.member_name }],
      })),
    }));
}
