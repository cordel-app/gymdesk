// #487 stage 2: shared pure calc for Promotion Charge/Period Benefit actions.
// `promotion_charge_benefits` and `promotion_period_benefits` both persist the
// same action/value vocabulary (see migrations 092/102/144) — this is the one
// place that turns an (action, value) pair into a resulting amount, so every
// caller (real billing in `computeFinalPrice`, and later the Period Benefit
// billing/forecast wiring of stages 3-4) agrees on the same math.

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
