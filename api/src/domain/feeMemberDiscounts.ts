/**
 * #2945 — the Direct Discount (%) of each Membership Fee line of a `per_member` plan (#2834).
 *
 * A `per_member` assignment owes one fee per beneficiary. Each beneficiary row of the plan
 * snapshot may carry its own discount (`plan_snapshot_beneficiaries.fee_direct_discount_percent`,
 * migration 429); this module is the one place that says what it means:
 *
 * - NULL: that fee follows the assignment's Personal Membership Fee Benefit (#772), as every fee
 *   did before the ticket — so nothing stored before it is repriced;
 * - 0..100: that fee is discounted by this percentage instead of the shared benefit (0 = none).
 *
 * The discount replaces the shared benefit for that one fee and is applied exactly where the
 * shared benefit is (last, after a governing Promotion and the Plan's durations), through the same
 * `applyPeriodBenefit()` arithmetic, so a Promotion still stacks with it as it stacks with #772.
 * A `per_family` plan has one fee and keeps using the shared benefit alone.
 *
 * Pure: no DB, no HTTP.
 */
import { NO_PERSONAL_FEE_BENEFIT, type PersonalFeeBenefit } from './personalFeeBenefit';

/** One beneficiary's fee discount: `null` = follow the assignment's shared benefit. */
export type FeeMemberDiscount = number | null;

/** The benefit one fee unit is priced with. */
export function feeUnitBenefit(shared: PersonalFeeBenefit, own: FeeMemberDiscount): PersonalFeeBenefit {
  if (own == null || !Number.isFinite(Number(own))) return shared;
  const pct = Math.min(100, Math.max(0, Number(own)));
  return pct === 0 ? NO_PERSONAL_FEE_BENEFIT : { action: 'percentage_discount', value: pct };
}

/**
 * The benefit of every fee unit, or `null` when every unit follows the shared benefit (the
 * engine then prices one fee and multiplies it, the pre-#2945 arithmetic to the cent). A list
 * whose length is not the unit count is ignored rather than guessed at.
 */
export function feeUnitBenefits(
  shared: PersonalFeeBenefit, discounts: readonly FeeMemberDiscount[] | null | undefined, units: number,
): PersonalFeeBenefit[] | null {
  if (!discounts || discounts.length !== units || units < 1) return null;
  if (discounts.every((d) => d == null)) return null;
  return discounts.map((d) => feeUnitBenefit(shared, d));
}

/**
 * The per-beneficiary discounts of a plan snapshot aliased `s`, in SQL: a comma list in
 * `member_id` order (an empty entry for NULL) for a `per_member` snapshot, NULL otherwise.
 * Same rows and count as `membershipFeeUnitsSql()`.
 */
export const feeMemberDiscountsSql = (s = 's') =>
  `(CASE WHEN ${s}.membership_fee_scope = 'per_member'
         THEN (SELECT GROUP_CONCAT(IFNULL(fdb.fee_direct_discount_percent, '') ORDER BY fdb.member_id SEPARATOR ',')
                 FROM plan_snapshot_beneficiaries fdb WHERE fdb.plan_snapshot_id = ${s}.id)
         ELSE NULL END)`;

/** Reads `feeMemberDiscountsSql()`'s value back. */
export function parseFeeMemberDiscounts(raw: unknown): FeeMemberDiscount[] | null {
  if (raw == null) return null;
  const text = String(raw);
  if (text === '') return [null];
  return text.split(',').map((p) => {
    if (p === '') return null;
    const n = Number(p);
    return Number.isFinite(n) ? n : null;
  });
}

export type FeeMemberDiscountsInput =
  | { kind: 'absent' }
  | { kind: 'value'; value: { memberId: number; percent: FeeMemberDiscount }[] }
  | { kind: 'error'; error: string };

/**
 * A request's `member_discounts`: absent keeps every stored value; otherwise a list of
 * `{ member_id, percent }` where `percent` is 0..100, or `null`/`''` to follow the shared
 * benefit again. Anything else is a 400, never a coercion. Whether each member is a beneficiary
 * of the plan is the writer's question (it needs the database).
 */
export function parseFeeMemberDiscountsInput(body: unknown): FeeMemberDiscountsInput {
  if (body == null || typeof body !== 'object' || !('member_discounts' in body)) return { kind: 'absent' };
  const raw = (body as Record<string, unknown>).member_discounts;
  if (raw === undefined) return { kind: 'absent' };
  if (!Array.isArray(raw)) return { kind: 'error', error: 'member_discounts must be an array' };
  const seen = new Set<number>();
  const value: { memberId: number; percent: FeeMemberDiscount }[] = [];
  for (const entry of raw) {
    const memberId = Number((entry as any)?.member_id);
    if (!Number.isInteger(memberId) || memberId <= 0) return { kind: 'error', error: 'member_discounts[].member_id must be a positive integer' };
    if (seen.has(memberId)) return { kind: 'error', error: 'member_discounts names a member twice' };
    seen.add(memberId);
    const p = (entry as any)?.percent;
    if (p == null || p === '') { value.push({ memberId, percent: null }); continue; }
    if (typeof p === 'boolean') return { kind: 'error', error: 'member_discounts[].percent must be a percentage between 0 and 100' };
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { kind: 'error', error: 'member_discounts[].percent must be a percentage between 0 and 100' };
    value.push({ memberId, percent: Math.round(n * 100) / 100 });
  }
  return { kind: 'value', value };
}
