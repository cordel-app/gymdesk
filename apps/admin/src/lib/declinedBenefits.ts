// #1184 stage 3 — which Plan benefits an assigner may untick. Presentation
// only: the API's `declinedBenefitsError()` is the enforcement, and this just
// keeps the checkbox honest about it. Pure.

export type BenefitSection = 'session' | 'oneoff' | 'periodical';

export interface AssignableBenefit {
  section: BenefitSection;
  product_id: number;
  product_name: string;
  mandatory: boolean;
}

export const BENEFIT_ENDPOINTS: Array<[BenefitSection, string]> = [
  ['session', 'session-benefits'],
  ['oneoff', 'oneoff-benefits'],
  ['periodical', 'periodical-benefits'],
];

/** A stored flag (`0`/`1`/boolean) read as Mandatory; absent means the default, Yes. */
export function isBenefitMandatory(raw: unknown): boolean {
  return !(raw === false || raw === 0 || raw === '0');
}

export function benefitKey(b: Pick<AssignableBenefit, 'section' | 'product_id'>): string {
  return `${b.section}:${b.product_id}`;
}

export function toAssignableBenefits(section: BenefitSection, rows: any[]): AssignableBenefit[] {
  return (rows ?? []).map((r) => ({
    section,
    product_id: Number(r.product_id),
    product_name: String(r.product_name ?? r.item_name ?? r.product_id),
    mandatory: isBenefitMandatory(r.mandatory),
  }));
}

/** The request's `declined_benefits`: only unticked *optional* lines, never a mandatory one. */
export function declinedPayload(
  benefits: AssignableBenefit[], declinedKeys: Set<string>,
): Array<{ section: BenefitSection; product_id: number }> {
  return benefits
    .filter((b) => !b.mandatory && declinedKeys.has(benefitKey(b)))
    .map((b) => ({ section: b.section, product_id: b.product_id }));
}
