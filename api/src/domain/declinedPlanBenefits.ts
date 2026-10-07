// #1184 stage 3 — declining an optional Plan benefit at assignment.
//
// A Plan benefit's `mandatory` flag (stage 2) says whether the Member must keep
// it. This is the one rule that turns a request's `declined_benefits` into a
// verdict, asked by every assignment path (staff create, assign-new-plan, the
// Plans page's bulk assign and the Member's own assign), so the Admin and
// Members flows cannot read `mandatory` two ways. The frontends' checkboxes are
// presentation; this is the enforcement. Pure — no DB, no HTTP.

export const BENEFIT_SECTIONS = ['session', 'oneoff', 'periodical'] as const;
export type BenefitSection = (typeof BENEFIT_SECTIONS)[number];

export interface DeclinedBenefit { section: BenefitSection; product_id: number }

/** One benefit line of the Plan being assigned, as the loader reads it. */
export interface PlanBenefitLine { section: BenefitSection; product_id: number; mandatory: boolean }

export type DeclinedBenefitsParse =
  | { ok: true; declined: DeclinedBenefit[] }
  | { ok: false; error: string };

/**
 * `declined_benefits` is `[{ section, product_id }]`. Absent/null means nothing
 * is declined (every benefit stays, which is every pre-ticket client's
 * behaviour); anything malformed is a 400, never a coercion.
 */
export function parseDeclinedBenefits(raw: unknown): DeclinedBenefitsParse {
  if (raw === undefined || raw === null) return { ok: true, declined: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'declined_benefits must be an array' };
  const declined: DeclinedBenefit[] = [];
  for (const item of raw) {
    const section = (item as any)?.section;
    const productId = Number((item as any)?.product_id);
    if (!BENEFIT_SECTIONS.includes(section) || !Number.isInteger(productId) || productId <= 0) {
      return { ok: false, error: 'declined_benefits entries need a valid section and product_id' };
    }
    if (!declined.some((d) => d.section === section && d.product_id === productId)) {
      declined.push({ section, product_id: productId });
    }
  }
  return { ok: true, declined };
}

/**
 * The verdict against the Plan's own lines: an entry naming a benefit the Plan
 * does not carry is an injected Product, and one naming a `mandatory = true`
 * benefit is a bypass attempt. Both are refused; neither is dropped quietly.
 */
export function declinedBenefitsError(lines: PlanBenefitLine[], declined: DeclinedBenefit[]): string | null {
  for (const d of declined) {
    const line = lines.find((l) => l.section === d.section && l.product_id === d.product_id);
    if (!line) return `Product ${d.product_id} is not a ${d.section} benefit of this plan`;
    if (line.mandatory) return `Product ${d.product_id} is a mandatory benefit and cannot be declined`;
  }
  return null;
}
