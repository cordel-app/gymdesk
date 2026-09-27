/**
 * #817 — which tax rate a Membership Plan's price is split at.
 *
 * A Plan's `tax_rate_id` is nullable, and the Pricing editor offers that as
 * **Default**: the Plan bills at the gym's own system rate (`tax_rates.is_system`,
 * seeded per gym as "Standard VAT" — the same row `seedSystemPtPackage()` picks).
 *
 * Those are two different questions and the card asks both:
 *
 * * **What is configured on the Plan** — the Tax rate row, which reads "Default"
 *   for a Plan that never picked one. That is `own`, and it stays `null`.
 * * **What the money is computed at** — the net/gross split beside the Current
 *   price, which has to exist either way (#817 §2: the row shows the
 *   tax-inclusive total *and* the net). That is `effective`.
 *
 * Deriving the second from the first is why the Current price used to read "—"
 * for a Plan on Default: `computePriceFields()` returns nulls without a rate, and
 * a Plan with a perfectly good price displayed as if it had none. The rule lives
 * here, on the server, rather than in the frontend, which must not re-derive it
 * (CLAUDE.md: no business logic duplicated in the frontend).
 *
 * A soft-deleted rate is still shown as the Plan's own — it is what is
 * configured, and `validateTaxRateId()` already refuses to *set* one — but it is
 * never chosen as the gym's default.
 */

export interface TaxRateCandidate {
  id: number;
  name: string;
  rate_percent: string;
  is_system: number;
  deleted_at: Date | string | null;
}

export interface PlanTaxRates<T extends TaxRateCandidate> {
  /** The Plan's own rate, or `null` when it is on "Default". */
  own: T | null;
  /** The rate the split is computed at: the Plan's own, else the gym's system rate. */
  effective: T | null;
}

export function selectPlanTaxRates<T extends TaxRateCandidate>(
  rows: T[],
  planTaxRateId: number | null | undefined,
): PlanTaxRates<T> {
  const own = planTaxRateId == null
    ? null
    : rows.find(r => Number(r.id) === Number(planTaxRateId)) ?? null;
  const systemDefault = rows.find(r => Number(r.is_system) === 1 && r.deleted_at == null) ?? null;
  return { own, effective: own ?? systemDefault };
}
