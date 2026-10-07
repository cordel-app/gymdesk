// #1184 stage 2 — a Membership Plan's Product benefit carries a **Mandatory**
// Yes/No: `true` (the default) means the member must keep the benefit when the
// Plan is assigned, `false` means they may decline it.
//
// **Not `products.mandatory`** (#832/#893, `domain/mandatoryPlanBenefits.ts`):
// that is the catalogue item's own flag and forces it into every Plan. This
// belongs to the Plan ↔ Product relationship, exactly where #896 put the
// `(action, value)` pair, and for that reason.
//
// Stage 2 configures, reports, copies and snapshots it; nothing declines a
// benefit yet (stage 3). Pure — no DB, no HTTP.

/** What every benefit written before this ticket means, and what a new one starts at. */
export const DEFAULT_PLAN_BENEFIT_MANDATORY = true;

/** A stored column value (`0`/`1`, `boolean`) as a boolean; anything else is the default. */
export function toPlanBenefitMandatory(value: unknown): boolean {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return DEFAULT_PLAN_BENEFIT_MANDATORY;
}

/**
 * What a replace-all `PUT` does with one line's `mandatory` — #896's/#918's
 * three answers: `keep` when the request did not mention it (so a quantity-only
 * save cannot reset an optional line to mandatory), `set` for a real boolean,
 * `error` for anything else (a 400, never a coercion — the string `"false"` is
 * truthy).
 */
export type PlanBenefitMandatoryInput =
  | { keep: true; mandatory?: undefined; error?: undefined }
  | { keep: false; mandatory: boolean; error?: undefined }
  | { keep?: undefined; mandatory?: undefined; error: string };

export function parsePlanBenefitMandatoryInput(item: unknown): PlanBenefitMandatoryInput {
  const raw = (item as { mandatory?: unknown } | null | undefined)?.mandatory;
  if (raw === undefined || raw === null) return { keep: true };
  if (raw === true || raw === 1) return { keep: false, mandatory: true };
  if (raw === false || raw === 0) return { keep: false, mandatory: false };
  return { error: 'mandatory must be a boolean' };
}
