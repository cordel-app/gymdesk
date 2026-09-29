// #899: the Membership Fee Benefit's Duration is picked from a list, not typed.
//
// #625 established the rule the list encodes: a Membership Fee Benefit can
// never outlast the Promotion it belongs to, so its Duration is bounded by the
// Promotion's own timeline — Free Period + Paid Duration + Bonus Duration.
// (Pay Beforehand is deliberately absent: it reclassifies paid periods as
// already-paid, it never lengthens the Promotion.) The backend enforces the
// same ceiling with a 400 (`PUT /promotions/:id/membership-fee-benefit`); this
// module is what stops a staff member reaching it, by never offering a value
// the Promotion cannot carry rather than accepting one and truncating it.
//
// The durations are counted in calendar months, which is what a Promotion's
// `free_months` / `paid_months` / `bonus_months` are — #892 moved *Membership
// Plan* durations onto the Plan's Billing frequency and left the Promotion side
// alone on purpose, and `promotionTimeline.ts` still steps one month per
// period.

/** Total Promotion duration in months: free + paid + bonus, each clamped at 0. */
export function promotionTimelineMonths(
  free: number | null | undefined,
  paid: number | null | undefined,
  bonus: number | null | undefined,
): number {
  const n = (v: number | null | undefined) => (Number.isFinite(v) ? Math.max(0, Math.trunc(v as number)) : 0);
  return n(free) + n(paid) + n(bonus);
}

/**
 * Every Duration the Promotion can carry: `1..maxDuration`.
 *
 * The "whole Promotion" choice is the null option the selector renders beside
 * this list, so 0 is not a member — the API treats a stored duration as a
 * positive integer and reads a null as "the whole Promotion". A Promotion with
 * no periods at all therefore offers that option alone, which is what keeps a
 * positive Duration off a zero-period Promotion.
 */
export function mfDurationOptions(maxDuration: number): number[] {
  if (!Number.isFinite(maxDuration) || maxDuration < 1) return [];
  return Array.from({ length: Math.trunc(maxDuration) }, (_, i) => i + 1);
}
