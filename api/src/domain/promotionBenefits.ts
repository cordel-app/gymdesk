// #487 stage 2: shared pure calc for Promotion Charge/Period Benefit actions.
// `promotion_charge_benefits` and `promotion_period_benefits` both persist the
// same action/value vocabulary (see migrations 092/102/144) — this is the one
// place that turns an (action, value) pair into a resulting amount, so every
// caller (real billing in `membership-fee-pricing.ts`, and later the Period
// Benefit billing/forecast wiring of stages 3-4) agrees on the same math.

export type PromotionBenefitAction =
  | 'no_benefit'
  | 'waive'
  | 'percentage_discount'
  | 'fixed_discount'
  | 'fixed_price';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Applies a single Promotion Charge/Period Benefit action to one amount.
 * Clamped at 0 — never negative. `no_benefit` returns `amount` unchanged.
 */
export function applyPeriodBenefit(
  amount: number,
  action: PromotionBenefitAction,
  value: number | null,
): number {
  let result = amount;
  if (action === 'waive') result = 0;
  else if (action === 'percentage_discount') result -= result * ((value ?? 0) / 100);
  else if (action === 'fixed_discount') result -= value ?? 0;
  else if (action === 'fixed_price') result = value ?? 0;
  if (result < 0) result = 0;
  return round2(result);
}

/**
 * #625: total duration of a Promotion's lifecycle in months — the sum of its
 * Free, Paid and Bonus periods. This is the single source of truth for how
 * long any Promotion Period Benefit (e.g. the Membership Fee Benefit) may
 * apply: a benefit belongs to the Promotion and can never outlast it.
 *
 * Pay Beforehand is deliberately NOT added — it only reclassifies some of the
 * Paid months as prepaid, it never lengthens the Promotion. The maximum is
 * `free + paid + bonus`, not `paid` alone.
 */
export function promotionDurationMonths(
  freeMonths: number | null,
  paidMonths: number | null,
  bonusMonths: number | null,
): number {
  const clamp = (n: number | null | undefined) => Math.max(0, Math.trunc(Number(n)) || 0);
  return clamp(freeMonths) + clamp(paidMonths) + clamp(bonusMonths);
}

/**
 * #625: the number of months a Membership Fee (Period) Benefit actually
 * applies for, capped at the Promotion duration so it can never bleed into the
 * regular (post-promotion) period. A null configured duration means
 * "unbounded" and therefore resolves to the full Promotion duration —
 * `effectiveBenefitDuration = min(configuredDuration, promotionDuration)`.
 */
export function effectiveBenefitDurationMonths(
  configuredDurationMonths: number | null,
  promotionDuration: number,
): number {
  const promo = Math.max(0, promotionDuration);
  if (configuredDurationMonths == null) return promo;
  return Math.min(Math.max(0, configuredDurationMonths), promo);
}
