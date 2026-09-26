// #772 — the Assigned Membership Plan's own **Personal Membership Fee
// Benefit**: a discount that belongs to the contract rather than to any
// Promotion, and therefore never expires.
//
// Every other thing that changes what the Membership Fee costs is bounded in
// time. A Promotion's Membership Fee Benefit lives inside that Promotion's own
// Free/Paid/Bonus timeline and ends with it (#635 stage 12, the thread's
// answer (a)); the Plan's Free, Pre-paid and Bonus durations are counted from
// `starts_at` and run out. This one is bounded by nothing:
//
//   > The benefit remains active for the entire lifetime of the Assigned
//   > Membership Plan, unless the Assigned Membership Plan is explicitly
//   > edited to change or remove it.
//
// Pure — no DB, no HTTP — so it is unit-testable without `createTestGym`
// (CLAUDE.md). The arithmetic itself is not duplicated: it is
// `applyPeriodBenefit`, the one place an (action, value) pair becomes an
// amount.

import { PromotionBenefitAction, applyPeriodBenefit } from './promotionBenefits';

/**
 * The actions #772 allows: *No benefit* and *% discount*, and nothing else.
 *
 * A subset of `PromotionBenefitAction` on purpose — the stored vocabulary is
 * shared so the pair is priced by `applyPeriodBenefit()` rather than by a
 * second copy of the percentage arithmetic, while this type is what keeps the
 * *product* surface to the two options the ticket asks for. Widening it is a
 * product decision; `waive` and `fixed_price` in particular would make an
 * open-ended benefit able to zero the fee forever, which nobody has asked for.
 */
export type PersonalFeeBenefitAction = Extract<PromotionBenefitAction, 'no_benefit' | 'percentage_discount'>;

export const PERSONAL_FEE_BENEFIT_ACTIONS: readonly PersonalFeeBenefitAction[] = [
  'no_benefit', 'percentage_discount',
];

/** The benefit configured on one assignment, normalized. */
export interface PersonalFeeBenefit {
  action: PersonalFeeBenefitAction;
  /** The percentage, 0..100. Always null for `no_benefit`. */
  value: number | null;
}

/** "Not configured" — and what every assignment carries until someone sets one. */
export const NO_PERSONAL_FEE_BENEFIT: PersonalFeeBenefit = { action: 'no_benefit', value: null };

export function isPersonalFeeBenefitAction(v: unknown): v is PersonalFeeBenefitAction {
  return typeof v === 'string' && (PERSONAL_FEE_BENEFIT_ACTIONS as readonly string[]).includes(v);
}

/**
 * A stored `(personal_fee_benefit_action, personal_fee_benefit_value)` pair as
 * the resolver needs it.
 *
 * Defensive in the same way `toPlanDuration()` is, and for the same reason:
 * `user_memberships` carries no CHECK for these columns (migration 192 — an
 * `ADD CONSTRAINT` would rebuild the busiest table in the schema), so a row
 * that somehow held an unknown action, a missing percentage or one outside
 * 0..100 must still price to something sane rather than to a negative fee. An
 * unusable pair reads as no benefit; a percentage is clamped to 0..100.
 */
export function toPersonalFeeBenefit(
  action: unknown, value: unknown,
): PersonalFeeBenefit {
  if (!isPersonalFeeBenefitAction(action) || action === 'no_benefit') return NO_PERSONAL_FEE_BENEFIT;
  const pct = Number(value);
  if (value == null || !Number.isFinite(pct)) return NO_PERSONAL_FEE_BENEFIT;
  return { action, value: Math.min(100, Math.max(0, pct)) };
}

/** Does this benefit change any amount at all? */
export function personalFeeBenefitApplies(benefit: PersonalFeeBenefit | null | undefined): boolean {
  return benefit != null && benefit.action !== 'no_benefit';
}

/**
 * The benefit applied to one already-resolved amount. `no_benefit` — and a
 * 0% discount — return the amount unchanged.
 */
export function applyPersonalFeeBenefit(
  amount: number, benefit: PersonalFeeBenefit | null | undefined,
): number {
  if (!personalFeeBenefitApplies(benefit)) return amount;
  return applyPeriodBenefit(amount, benefit!.action, benefit!.value);
}
