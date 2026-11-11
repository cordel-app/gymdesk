// #1537 — what a recurring-configuration Draft changes relative to the version
// it would replace, as pure decisions.
//
// The "Review your changes" step shows this and nothing in it prices anything:
// each line carries the frozen unit price of its own version, and the amount
// due is `initialCharge()`'s (the one function Save & Pay charges from).

import type { SimulationAssignment } from './billingSimulation';

export interface RecurringLine {
  key: string;
  productId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  billingFrequency: string | null;
}

export type ConfigurationChange =
  | { kind: 'added'; line: RecurringLine }
  | { kind: 'removed'; line: RecurringLine }
  | { kind: 'quantity_changed'; line: RecurringLine; from: number; to: number }
  | { kind: 'price_changed'; line: RecurringLine; from: number; to: number }
  | { kind: 'plan_changed'; from: string | null; to: string | null }
  | { kind: 'fee_changed'; from: number | null; to: number | null }
  | { kind: 'promotion_added'; name: string }
  | { kind: 'promotion_removed'; name: string };

/**
 * The recurring lines of a version: its Additional Periodic Services still
 * running and the Period benefits of its Membership Plan, keyed by
 * the purchase's `lineRef` (#1865: the same Product bought twice is two lines),
 * falling back to the Product for a line that predates it.
 */
export function recurringLinesOf(a: Pick<SimulationAssignment, 'services' | 'planBenefits'> | null): RecurringLine[] {
  if (!a) return [];
  const lines = new Map<string, RecurringLine>();
  for (const b of a.planBenefits) {
    if (b.category !== 'periodical') continue;
    lines.set(`benefit-${b.productId}`, {
      key: `benefit-${b.productId}`, productId: b.productId, name: b.name, quantity: b.quantity,
      unitPrice: b.unitPrice, billingFrequency: b.billingFrequency,
    });
  }
  for (const s of a.services) {
    if (s.endsOn != null) continue;
    // A purchase is recognised across versions by its `lineRef`; a line that
    // predates it is the Product's one line.
    const key = s.lineRef != null ? `service-ref-${s.lineRef}` : `service-${s.productId}`;
    lines.set(key, {
      key, productId: s.productId, name: s.name, quantity: s.quantity,
      unitPrice: s.unitPrice, billingFrequency: s.billingFrequency,
    });
  }
  return [...lines.values()];
}

const cents = (n: number | null) => (n == null ? null : Math.round(n * 100));

/**
 * `before` is the Active version (or `null` for a member with no recurring
 * configuration, where everything is an addition).
 */
export function diffConfigurations(
  before: SimulationAssignment | null, after: SimulationAssignment,
): ConfigurationChange[] {
  const out: ConfigurationChange[] = [];
  const was = new Map(recurringLinesOf(before).map((l) => [l.key, l]));
  const now = new Map(recurringLinesOf(after).map((l) => [l.key, l]));

  for (const [key, line] of now) {
    const prev = was.get(key);
    if (!prev) { out.push({ kind: 'added', line }); continue; }
    if (prev.quantity !== line.quantity) out.push({ kind: 'quantity_changed', line, from: prev.quantity, to: line.quantity });
    if (cents(prev.unitPrice) !== cents(line.unitPrice)) out.push({ kind: 'price_changed', line, from: prev.unitPrice, to: line.unitPrice });
  }
  for (const [key, line] of was) if (!now.has(key)) out.push({ kind: 'removed', line });

  // A first configuration has no version to compare against, but a Membership
  // Plan it carries is still a change: without this a Draft holding only a new
  // plan lists nothing, and the Products tab's Save & Pay never opens (#2097).
  if (!before && after.planName) out.push({ kind: 'plan_changed', from: null, to: after.planName });
  if (before) {
    if ((before.planName ?? null) !== (after.planName ?? null)) out.push({ kind: 'plan_changed', from: before.planName ?? null, to: after.planName ?? null });
    if (cents(before.membershipFeePrice) !== cents(after.membershipFeePrice)) out.push({ kind: 'fee_changed', from: before.membershipFeePrice, to: after.membershipFeePrice });
  }

  const standing = (a: SimulationAssignment | null) =>
    new Set((a?.promotions ?? []).filter((p) => p.revokedAt == null).map((p) => p.name ?? ''));
  const pBefore = standing(before);
  const pAfter = standing(after);
  for (const name of pAfter) if (!pBefore.has(name)) out.push({ kind: 'promotion_added', name });
  for (const name of pBefore) if (!pAfter.has(name)) out.push({ kind: 'promotion_removed', name });
  return out;
}

// #2446 stage 2 — the Summary lists every item of the pending Product Set, not
// only the differences: what stays (active), what the Draft adds (draft) and
// what it takes away (cancelling). Frozen figures only; nothing here prices.
export type SummaryItemState = 'active' | 'draft' | 'cancelling';

export interface SummaryItem {
  state: SummaryItemState;
  type: 'plan' | 'product';
  name: string;
  quantity: number | null;
  /** The product's own frequency; for a plan, its cadence as `<interval>_<unit>`. */
  billing_frequency: string | null;
  regular_price: number | null;
  promotions: string[];
}

const planItem = (a: SimulationAssignment, state: SummaryItemState): SummaryItem | null =>
  a.planName
    ? {
        state, type: 'plan', name: a.planName, quantity: null,
        billing_frequency: a.recurringInterval != null && a.recurringUnit ? `${a.recurringInterval}_${a.recurringUnit}` : null,
        regular_price: a.membershipFeePrice,
        promotions: a.promotions.filter((p) => p.revokedAt == null).map((p) => p.name ?? ''),
      }
    : null;

const lineItem = (l: RecurringLine, state: SummaryItemState): SummaryItem => ({
  state, type: 'product', name: l.name, quantity: l.quantity,
  billing_frequency: l.billingFrequency, regular_price: l.unitPrice, promotions: [],
});

/** `before` is the Active version (`null` when there is none), `after` the Draft. */
export function summaryItems(before: SimulationAssignment | null, after: SimulationAssignment): SummaryItem[] {
  const out: SummaryItem[] = [];
  const was = new Map(recurringLinesOf(before).map((l) => [l.key, l]));
  const now = new Map(recurringLinesOf(after).map((l) => [l.key, l]));

  const prevPlan = before?.planName ?? null;
  const nextPlan = after.planName ?? null;
  if (before && prevPlan && prevPlan !== nextPlan) { const p = planItem(before, 'cancelling'); if (p) out.push(p); }
  const plan = planItem(after, before && prevPlan === nextPlan ? 'active' : 'draft');
  if (plan) out.push(plan);

  for (const [key, l] of now) out.push(lineItem(l, was.has(key) ? 'active' : 'draft'));
  for (const [key, l] of was) if (!now.has(key)) out.push(lineItem(l, 'cancelling'));
  return out;
}

// #2446 stage 3 — the Summary's financial view. The figures are the engine's:
// a recurring item's final price is read off the version's own Billing Event
// Forecast, the initial payment and its discounts off the commit charge
// (`commitCharge()`, what Save & Pay asks for). This module only picks lines
// and adds them up; it prices nothing.

/** The forecast line shape this needs (`BillingEventLine`, structurally). */
export interface ForecastLineLike {
  kind: 'membership_fee' | 'product';
  label: string;
  actual_charge: number;
  prepaid_periods: number | null;
  proration?: { prorated_days: number; period_days: number } | null;
}

export interface RecurringFinalPrices {
  /** The Membership Fee's per-period charge, `null` when the forecast has none. */
  fee: number | null;
  /** Each Product's per-period charge (its whole line, quantity included), by name. */
  products: Map<string, number>;
}

/**
 * The first ordinary charge of each recurring item in a forecast (dates in
 * order): a prorated first stretch (#1867) and a Pre-paid lump (#946) are not a
 * period's price, so they are passed over while a later occurrence exists.
 */
export function recurringFinalPrices(dates: Array<{ date: string; lines: ForecastLineLike[] }>): RecurringFinalPrices {
  const ordered = [...dates].sort((a, b) => a.date.localeCompare(b.date));
  const regular = new Map<string, number>();
  const fallback = new Map<string, number>();
  for (const d of ordered) {
    for (const l of d.lines) {
      const key = l.kind === 'membership_fee' ? '\u0000fee' : l.label;
      const odd = l.proration != null || l.prepaid_periods != null;
      const target = odd ? fallback : regular;
      if (!target.has(key)) target.set(key, round2(Number(l.actual_charge)));
    }
  }
  const pick = (key: string) => regular.get(key) ?? fallback.get(key) ?? null;
  const products = new Map<string, number>();
  for (const key of new Set([...regular.keys(), ...fallback.keys()])) {
    if (key !== '\u0000fee') products.set(key, pick(key)!);
  }
  return { fee: pick('\u0000fee'), products };
}

/** The recurring final price of one Summary item, from its own version's forecast. */
export function itemFinalPrice(item: Pick<SummaryItem, 'type' | 'name'>, prices: RecurringFinalPrices | null): number | null {
  if (!prices) return null;
  return item.type === 'plan' ? prices.fee : prices.products.get(item.name) ?? null;
}

export interface RecurringTotals {
  /** The item's billing frequency as the Summary reports it. */
  billing_frequency: string | null;
  existing: number;
  new: number;
  cancelling: number;
  /** What the set charges per period once committed: existing + new. */
  resulting: number;
}

export interface FinancialSummary {
  /** Per billing frequency, because a monthly and a yearly charge do not add up. */
  recurring: RecurringTotals[];
  /** Regular price minus charge over the initial payment's lines (promotions, treatments, discounts). */
  initial_discounts: number;
  initial_payment: number | null;
  /** The amount Save & Pay asks for: the initial payment, unchanged. */
  amount_payable: number | null;
}

export interface InitialLineLike {
  quantity: number;
  amount: number;
  regular_unit_price: number | null;
}

export function financialSummary(
  items: Array<Pick<SummaryItem, 'state' | 'billing_frequency'> & { final_price: number | null }>,
  initialLines: InitialLineLike[],
  amountDue: number | null,
): FinancialSummary {
  const groups = new Map<string, RecurringTotals>();
  for (const i of items) {
    if (i.final_price == null) continue;
    const key = i.billing_frequency ?? '';
    const g = groups.get(key) ?? { billing_frequency: i.billing_frequency, existing: 0, new: 0, cancelling: 0, resulting: 0 };
    if (i.state === 'active') g.existing += i.final_price;
    else if (i.state === 'draft') g.new += i.final_price;
    else g.cancelling += i.final_price;
    groups.set(key, g);
  }
  const recurring = [...groups.values()].map((g) => ({
    ...g,
    existing: round2(g.existing), new: round2(g.new), cancelling: round2(g.cancelling),
    resulting: round2(g.existing + g.new),
  }));
  const discounts = initialLines.reduce((n, l) =>
    l.regular_unit_price == null ? n : n + Math.max(0, l.regular_unit_price * l.quantity - l.amount), 0);
  return {
    recurring,
    initial_discounts: round2(discounts),
    initial_payment: amountDue,
    amount_payable: amountDue,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
