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

import type { FeeChargeSplit } from './billingSimulation';

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
  };
}

export interface InitialPaymentLine {
  name: string | null;
  quantity: number;
  /** The price of one unit, VAT included, before discounts. */
  unit_price: number;
  /** #2890 — the line before discounts (unit price × quantity), VAT included. */
  line_total: number;
  /** The line total minus the charge; 0 when nothing was taken off. */
  discount: number;
  /** What the discount is: the Promotion's name, else the line's own treatment. */
  promotion_name: string | null;
  treatment_action: string | null;
  treatment_value: number | null;
  tax_rate_percent: number | null;
  tax_amount: number;
  /** The line's final amount, VAT included. */
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
}

export interface InitialPaymentTaxRow {
  /** `null` groups the lines that carry no tax rate. */
  rate_percent: number | null;
  base: number;
  tax: number;
}

export interface InitialPayment {
  lines: InitialPaymentLine[];
  /** #2890 — the lines' totals before discounts, VAT included; minus `discount_total` it is the charge. */
  total_before_discounts: number;
  subtotal_excl_tax: number;
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
    const { unit, lineTotal } = regularLinePrices(l.regular_unit_price, quantity, amount);
    const discount = Math.max(0, round2(lineTotal - amount));
    const rate = l.tax_rate_percent != null ? Number(l.tax_rate_percent) : null;
    const key = rate == null ? '' : String(rate);
    const row = taxes.get(key) ?? { rate_percent: rate, base: 0, tax: 0 };
    row.base = round2(row.base + net);
    row.tax = round2(row.tax + tax);
    taxes.set(key, row);
    return {
      name: l.item_name, quantity, unit_price: unit, line_total: lineTotal, discount,
      promotion_name: l.promotion_name, treatment_action: l.treatment_action, treatment_value: l.treatment_value,
      tax_rate_percent: rate, tax_amount: tax, amount,
      prepaid_periods: l.prepaid_periods != null && l.prepaid_periods > 0 ? Number(l.prepaid_periods) : null,
      prepaid_cadence: l.prepaid_periods != null && l.prepaid_periods > 0 ? l.prepaid_cadence ?? null : null,
      fee_split: l.fee_split ?? null,
    };
  });
  const taxRows = [...taxes.values()]
    .filter((r) => r.rate_percent != null)
    .sort((a, b) => (a.rate_percent ?? 0) - (b.rate_percent ?? 0));
  return {
    lines: out,
    total_before_discounts: round2(out.reduce((n, l) => n + l.line_total, 0)),
    subtotal_excl_tax: round2(out.reduce((n, l) => n + (l.amount - l.tax_amount), 0)),
    discount_total: round2(out.reduce((n, l) => n + l.discount, 0)),
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
