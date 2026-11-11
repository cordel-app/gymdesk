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
