// #1187 — the quantity an Assigned Plan's benefit line carries.
//
// A Product with `products.mandatory = true` (#832/#893) is a charge that
// applies **per covered Member** (Registration Fee, Insurance Fee…), so on an
// *assignment* its quantity is the number of Members the Membership covers —
// replacing the Plan's configured quantity, never multiplying it. The Plan's
// own row is untouched: the reusable template keeps its configured quantity and
// only the Assigned Plan snapshot becomes Member-dependent.
//
// This is the catalogue flag and nothing else. The Plan benefit's own
// `mandatory` Yes/No (#1184, `planBenefitMandatory.ts`) says whether a Member
// may decline the line; it does not decide the quantity, and the two are never
// read for each other. Pure — no DB, no HTTP.

/** Members covered by an assignment, floored at 1: the owner is always covered. */
export function coveredMemberCount(n: unknown): number {
  const count = Math.trunc(Number(n));
  return Number.isFinite(count) && count >= 1 ? count : 1;
}

/**
 * The quantity an Assigned Plan line takes: the covered-Member count for a
 * catalogue-mandatory Product, the configured quantity for every other one.
 */
export function resolveAssignedPlanBenefitQuantity(params: {
  productMandatory: boolean;
  configuredQuantity: number;
  memberCount: number;
}): number {
  return params.productMandatory
    ? coveredMemberCount(params.memberCount)
    : params.configuredQuantity;
}
