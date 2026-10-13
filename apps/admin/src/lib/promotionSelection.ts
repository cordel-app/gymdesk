// #1539 — the Promotion selector's rules, pure so both forms ask one answer.
//
// The server is the authority (`priceProductPurchase()`, `validatePromotionSelection()`);
// this only decides what the checkboxes offer while the user is choosing, using
// the same `stackable` flag: a selection of two or more is valid only when every
// member is stackable, so evaluating the *whole* combination reduces to
// "a non-stackable one is selected → nothing else; anything selected → no
// non-stackable one".

export interface SelectablePromotion {
  id: number;
  stackable: boolean;
}

export type PromotionBlock = 'blocked_by_non_stackable' | 'non_stackable_with_selection' | null;

export function promotionBlock(
  candidate: SelectablePromotion,
  all: readonly SelectablePromotion[],
  selectedIds: readonly number[],
): PromotionBlock {
  if (selectedIds.includes(candidate.id)) return null;
  const selected = all.filter((p) => selectedIds.includes(p.id));
  if (selected.some((p) => !p.stackable)) return 'blocked_by_non_stackable';
  if (selected.length > 0 && !candidate.stackable) return 'non_stackable_with_selection';
  return null;
}

/** Drops ids that are no longer offered (the Product or Plan changed, or one lapsed). */
export function revalidateSelection(selectedIds: readonly number[], offered: readonly SelectablePromotion[]): number[] {
  const byId = new Map(offered.map((p) => [p.id, p]));
  const kept = selectedIds.filter((id) => byId.has(id));
  const chosen = kept.map((id) => byId.get(id)!);
  return kept.length > 1 && chosen.some((p) => !p.stackable) ? [kept[0]] : kept;
}

export interface PromotionBenefitInput {
  action: string;
  value: number | null;
  duration_cycles: number | null;
}

/** The locale key and values describing a benefit, from its configuration alone. */
export function promotionBenefitDescription(
  b: PromotionBenefitInput,
  money: (n: number) => string,
): { key: string; values: Record<string, string | number> } | null {
  const cycles = b.duration_cycles != null && b.duration_cycles > 0 ? b.duration_cycles : null;
  const suffix = cycles == null ? '' : '_periods';
  const values: Record<string, string | number> = { periods: cycles ?? 0 };
  switch (b.action) {
    case 'waive':
      return { key: `promo_desc_waive${suffix}`, values };
    case 'percentage_discount':
      return b.value == null ? null : { key: `promo_desc_percent${suffix}`, values: { ...values, value: b.value } };
    case 'fixed_discount':
      return b.value == null ? null : { key: `promo_desc_fixed_discount${suffix}`, values: { ...values, value: money(b.value) } };
    case 'fixed_price':
      return b.value == null ? null : { key: `promo_desc_fixed_price${suffix}`, values: { ...values, value: money(b.value) } };
    default:
      return null;
  }
}
