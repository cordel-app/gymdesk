// #1128: one place decides how a billing frequency **reads**.
//
// A Product's Billing Frequency is a stored value (`products.billing_frequency`,
// `api/src/domain/productFrequency.ts`) and a Membership Plan's is a stored
// `(interval, unit)` pair (`billing_policies`, `api/src/domain/
// planBillingFrequency.ts`). Neither of those is changed here and neither may be:
// what may be *stored* and what may be *configured* stay the API's answers
// (#945/#821 for a Product, #820 for a Plan).
//
// What this module owns is the third question — what a stored frequency is
// *called* on screen — because the answer had been spelled five times. The same
// monthly Product read `Month` on the Products page, `Month(s)` in a Membership
// Plan's benefit row, `Month(s)` again in a Promotion's, and `Monthly` on an
// Assigned Plan card, and a Plan billed every four weeks read `4 Weeks` beside
// Products that read the same thing three other ways. So the labels live in one
// locale namespace (`billing_frequency`, the same keys in en/es/ca) and every
// surface resolves them through `billingFrequencyLabelKey()`:
//
//   once        → Once
//   four_weeks  → Every 4 weeks
//   month       → Monthly
//   year        → Yearly
//
// Two things this is deliberately **not**:
//
//   * It is not a new accepted set. `week` and `per_session` are retired from
//     the Product dropdown (#821/#945) and still stored, read and billed, so
//     they keep a label here — one label, rather than the four spellings they
//     had — and nothing about them becomes selectable again.
//   * It is not a Session Benefit's Frequency. That is a different question
//     (how often an allowance *renews*, #918) with its own accepted set and its
//     own `plans.session_frequency_*` keys, `Weekly` among them, and this module
//     must never be pointed at it.
//
// A Plan's cadence is labelled from the same table, because a Membership Plan
// has no frequency terminology of its own (#1128: no `Month(s)`, `Year(s)`,
// `1 Month` or `1 Year`). The *period noun* a duration is counted in — `2 × 4
// Weeks` (#892) — is a different sentence and keeps its own `plans.period_unit_*`
// keys: "2 × Every 4 weeks" is not English.

/** The locale namespace holding the labels. One namespace, one spelling. */
export const BILLING_FREQUENCY_NAMESPACE = 'billing_frequency';

/**
 * Every value a Product's `billing_frequency` column may hold — the four
 * offered ones plus the two retired ones, which are still displayed wherever
 * they are stored. Mirrors `STORED_PRODUCT_FREQUENCIES`
 * (`api/src/domain/productFrequency.ts`); the API is what enforces which may be
 * written.
 */
export const LABELLED_BILLING_FREQUENCIES = [
  'once',
  'four_weeks',
  'month',
  'year',
  'week',
  'per_session',
] as const;

export type LabelledBillingFrequency = (typeof LABELLED_BILLING_FREQUENCIES)[number];

/**
 * The key inside `BILLING_FREQUENCY_NAMESPACE` that labels a stored frequency,
 * or `null` for a value this codebase does not know. `null` is what makes a
 * caller render `—` rather than the key itself: next-intl prints a missing key
 * verbatim, so a surface that interpolated an unknown value into
 * `frequency_${value}` would show `billing_frequency.frequency_fortnight` to a
 * gym owner.
 */
export function billingFrequencyLabelKey(value: unknown): string | null {
  return typeof value === 'string'
    && (LABELLED_BILLING_FREQUENCIES as readonly string[]).includes(value)
    ? `frequency_${value}`
    : null;
}

/**
 * The label for a stored frequency, or `null` when there is nothing to label —
 * an item with no frequency configured, or a value outside the set. A caller
 * renders `—` for `null`; this is the one place that decides which it is, so no
 * surface interpolates a raw column value into a locale key.
 */
export function billingFrequencyLabel(
  value: unknown,
  tFreq: (key: string) => string,
): string | null {
  const key = billingFrequencyLabelKey(value);
  return key ? tFreq(key) : null;
}

// ─── A Membership Plan's cadence ──────────────────────────────────────────────
//
// The admin mirror of `api/src/domain/planBillingFrequency.ts` (#820): a Plan's
// Billing frequency is a choice of two, stored as the pair the nightly run
// steps. It lives here rather than beside the Plans page because an Assigned
// Plan card renders the same pair from `components/assignedPlan/`, which cannot
// import a page module — and because the pair and its label are one answer.
// `app/[locale]/plans/planProfile.ts` re-exports these rather than restating
// them.

export const PLAN_BILLING_FREQUENCIES = ['month', 'four_weeks'] as const;

export type PlanBillingFrequency = (typeof PLAN_BILLING_FREQUENCIES)[number];

/** What each choice stores. */
export const PLAN_BILLING_FREQUENCY_CADENCES: Record<
  PlanBillingFrequency,
  { interval: number; unit: string }
> = {
  month: { interval: 1, unit: 'month' },
  four_weeks: { interval: 4, unit: 'week' },
};

/**
 * Which choice a stored pair is, or `null` for a cadence outside the two: a
 * Plan configured before #820, or a row written straight into the database.
 * `null` is deliberately not coerced to a choice — a surface that coerced it
 * would tell a gym it bills monthly while the run charges every two months.
 */
export function planBillingFrequencyOf(interval: unknown, unit: unknown): PlanBillingFrequency | null {
  const n = Number(interval);
  if (!Number.isInteger(n)) return null;
  for (const freq of PLAN_BILLING_FREQUENCIES) {
    const cadence = PLAN_BILLING_FREQUENCY_CADENCES[freq];
    if (cadence.interval === n && cadence.unit === unit) return freq;
  }
  return null;
}

/**
 * `Every 2 months` — how a cadence no choice matches reads. Unlocalized, as it
 * was before this module: it is the shape of a row nobody can configure any
 * more, and inventing a per-unit plural rule for three languages to describe it
 * would be a second frequency vocabulary.
 */
export function legacyCadenceText(interval: number, unit: string): string {
  return `Every ${interval === 1 ? unit : `${interval} ${unit}s`}`;
}

/**
 * What a stored cadence reads as: `Monthly`, `Every 4 weeks`, or the legacy
 * text. `tFreq` is a translator for `BILLING_FREQUENCY_NAMESPACE`, so a Plan's
 * Billing frequency, an Assigned Plan's frozen cadence and a Product billed on
 * the same period cannot be named three different things.
 */
export function cadenceFrequencyLabel(
  interval: unknown,
  unit: unknown,
  tFreq: (key: string) => string,
): string {
  const freq = planBillingFrequencyOf(interval, unit);
  if (freq) return tFreq(billingFrequencyLabelKey(freq) as string);
  return legacyCadenceText(Number(interval), String(unit));
}
