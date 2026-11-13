// #2779 — what an expanded **Past Plan** of the Members App shows: the Product
// lines and the Promotions that plan was agreed with, read from its snapshots
// and nothing else.
//
// Pure, so the shaping is assertable with no database
// (`api/src/test/past-plan-details.unit.test.ts`); `api/src/api/me-past-plan-details.ts`
// is the I/O half.
//
// Three of its answers are the rule rather than the implementation.
//
//  - **Every value is the snapshot's.** A line is a `plan_{session,oneoff,periodical}_snapshots`
//    row and a Promotion is its `user_membership_promotions` application with that
//    application's own `snapshot` JSON and grant snapshot rows (#635 §16, #1995). No
//    catalogue table is read, so a Product, Plan or Promotion renamed, repriced or
//    deleted since moves nothing here, and a value the snapshot does not hold is
//    absent rather than filled in from the live row.
//  - **No line price is stated.** A plan line freezes its `unit_price` but not the
//    tax treatment that says whether that figure is VAT-inclusive (every staff
//    surface grosses it up through the live Product's `tax_behavior`, #924 stage 1),
//    so quoting it to a member would either use the live catalogue or state a figure
//    that may be net. A line therefore reports its quantity, its treatment and its
//    Direct Discount — the "discount information" it does freeze — and no amount.
//    The plan's own agreed Membership Fee is the figure the plan charged, which is
//    VAT-inclusive (#635 stage 12), so that one is reported.
//  - **A line split per member is one line to the member** (#2657 stage 3 splits an
//    Individual line into one row per beneficiary): rows of the same Product with the
//    same treatment are merged, quantities summed, so the history reads as the plan
//    was sold rather than as its internal allocation.

import type { ProductBenefitCategory } from './productClassification';

export type PastPlanLineCategory = ProductBenefitCategory;

/** A plan line snapshot row, as the loader projects it from any of the three tables. */
export interface PastPlanLineRow {
  plan_snapshot_id: number;
  category: PastPlanLineCategory;
  product_id: number | null;
  item_name: string;
  item_type: string | null;
  item_billing_frequency: string | null;
  quantity: number | string;
  mandatory: number | boolean | string | null;
  action: string | null;
  value: number | string | null;
  direct_discount_percent: number | string | null;
  /** Session lines only (#918): how often the allowance renews. */
  frequency?: string | null;
}

/** One line of an expanded Past Plan. */
export interface PastPlanLine {
  category: PastPlanLineCategory;
  product_name: string;
  product_type: string | null;
  billing_frequency: string | null;
  /** A Session Benefit's renewal frequency (`week`, `month`…), `null` elsewhere. */
  session_frequency: string | null;
  quantity: number;
  mandatory: boolean;
  /** The line's Benefit treatment (`no_benefit` | `waive` | `percentage_discount`). */
  action: string;
  /** The treatment's percentage, `null` for an action that takes none. */
  value: number | null;
  /** The line's own Direct Discount % (#2490 stage 3), `null` when none was agreed. */
  direct_discount_percent: number | null;
}

/** A Product a Promotion granted, as its grant snapshot holds it. */
export interface PastPlanPromotionGrant {
  product_name: string;
  quantity: number;
  action: string;
  value: number | null;
}

/** A Membership Fee Benefit as the application's snapshot holds it. */
export interface PastPlanFeeBenefit {
  action: string;
  value: number | null;
  duration_months: number | null;
}

/** One Promotion applied to a past plan. */
export interface PastPlanPromotion {
  id: number;
  /** The name the Promotion carried when applied; `null` when the snapshot holds none. */
  name: string | null;
  status: string;
  applied_at: string | null;
  revoked_at: string | null;
  membership_fee_benefits: PastPlanFeeBenefit[];
  products: PastPlanPromotionGrant[];
}

/** What an expanded Past Plan shows, beside the row the header already carries. */
export interface PastPlanDetails {
  /** The agreed Membership Fee (VAT-inclusive), `null` when the snapshot holds none. */
  membership_fee_price: number | null;
  billing_interval: number | null;
  billing_unit: string | null;
  lines: PastPlanLine[];
  promotions: PastPlanPromotion[];
}

const CATEGORY_ORDER: PastPlanLineCategory[] = ['session', 'oneoff', 'periodical'];

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

/** A DATE or DATETIME as `YYYY-MM-DD`, the form every member-facing date takes. */
export function toDateOnly(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const text = String(value);
  return text ? text.slice(0, 10) : null;
}

/** The lines of one plan snapshot, merged per Product and treatment, in section order. */
export function shapePastPlanLines(rows: readonly PastPlanLineRow[]): PastPlanLine[] {
  const merged = new Map<string, PastPlanLine>();
  for (const row of rows) {
    const action = row.action ?? 'no_benefit';
    const value = action === 'no_benefit' || action === 'waive' ? null : numberOrNull(row.value);
    const discount = numberOrNull(row.direct_discount_percent);
    const directDiscount = discount != null && discount > 0 ? discount : null;
    const mandatory = truthy(row.mandatory);
    const quantity = Math.max(0, Number(row.quantity) || 0);
    const key = [row.category, row.product_id ?? `name:${row.item_name}`, action, value, directDiscount, mandatory,
      row.frequency ?? ''].join('|');
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += quantity;
      continue;
    }
    merged.set(key, {
      category: row.category,
      product_name: row.item_name,
      product_type: row.item_type ?? null,
      billing_frequency: row.item_billing_frequency ?? null,
      session_frequency: row.category === 'session' ? (row.frequency ?? null) : null,
      quantity,
      mandatory,
      action,
      value,
      direct_discount_percent: directDiscount,
    });
  }
  return [...merged.values()].sort((a, b) =>
    CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
    || a.product_name.localeCompare(b.product_name));
}

/** The application row the loader reads from `user_membership_promotions`. */
export interface PastPlanPromotionRow {
  id: number;
  status: string;
  snapshot: unknown;
  applied_at: unknown;
  revoked_at: unknown;
}

function parseSnapshot(snapshot: unknown): any {
  if (snapshot == null) return null;
  if (typeof snapshot === 'string') {
    try { return JSON.parse(snapshot); } catch { return null; }
  }
  return snapshot;
}

/**
 * One application, from its own snapshot. `feeBenefits` is what
 * `membershipFeeBenefitsFromSnapshot()` read off the same JSON (the one reader of
 * that shape, legacy layouts included); only an enabled benefit that does something
 * is reported, so a Promotion with no fee benefit shows its granted Products alone.
 */
export function shapePastPlanPromotion(
  row: PastPlanPromotionRow,
  feeBenefits: ReadonlyArray<{ enabled?: boolean; action: string | null; value: number | null; duration_months: number | null }>,
  grants: readonly PastPlanPromotionGrant[],
): PastPlanPromotion {
  const snap = parseSnapshot(row.snapshot);
  const name = typeof snap?.name === 'string' && snap.name.trim() !== '' ? snap.name : null;
  return {
    id: Number(row.id),
    name,
    status: String(row.status),
    applied_at: toDateOnly(row.applied_at),
    revoked_at: toDateOnly(row.revoked_at),
    membership_fee_benefits: feeBenefits
      .filter((b) => b.enabled !== false && b.action != null && b.action !== 'no_benefit')
      .map((b) => ({
        action: String(b.action),
        value: numberOrNull(b.value),
        duration_months: numberOrNull(b.duration_months),
      })),
    products: [...grants],
  };
}

/** The snapshot JSON as the loader reads it, for `membershipFeeBenefitsFromSnapshot()`. */
export function pastPlanPromotionSnapshot(row: PastPlanPromotionRow): any {
  return parseSnapshot(row.snapshot);
}

/** A past plan with no snapshot to read: nothing to expand into. */
export const EMPTY_PAST_PLAN_DETAILS: PastPlanDetails = {
  membership_fee_price: null, billing_interval: null, billing_unit: null, lines: [], promotions: [],
};
