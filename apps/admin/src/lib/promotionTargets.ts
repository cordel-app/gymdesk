/**
 * #926: the `APPLIES TO` radio group's options — what a Promotion applies to.
 *
 * Mirrors `PROMOTION_TARGETS` in `api/src/domain/promotionTarget.ts`, which is
 * where the accepted set is decided and which the `chk_promotions_applies_to`
 * CHECK (migration 204) mirrors in SQL. A target added there and missed here
 * would be storable but unconfigurable; one added here and missed there would
 * be offered by the radio group and 400 on save. `promotion-target.unit.test.ts`
 * asserts the two lists — and the locale keys below — agree.
 *
 * The labels stay the page's: the key is resolved in the `promotions` namespace,
 * so next-intl prints a missing key verbatim and a new option needs its
 * `applies_to_<target>` key in `apps/admin/locales/base/{en,es,ca}.json`.
 */

export type PromotionTarget = 'membership_plan' | 'sellable_item';

export const PROMOTION_TARGET_OPTIONS: readonly { value: PromotionTarget; labelKey: string }[] = [
  { value: 'membership_plan', labelKey: 'applies_to_membership_plan' },
  { value: 'sellable_item', labelKey: 'applies_to_sellable_item' },
];

/**
 * What a Promotion with no stored target is — the behaviour every Promotion had
 * before the column existed, and `promotions.applies_to`'s own DEFAULT.
 */
export const DEFAULT_PROMOTION_TARGET: PromotionTarget = 'membership_plan';

export function promotionTargetOrDefault(value: unknown): PromotionTarget {
  return PROMOTION_TARGET_OPTIONS.some((o) => o.value === value)
    ? (value as PromotionTarget)
    : DEFAULT_PROMOTION_TARGET;
}

/**
 * Whether the Membership-Plan-specific configuration applies — the Membership
 * Fee Promotion section and Suitable Membership Plans. One predicate, so the
 * form, the read-only view and the save path cannot disagree about which
 * sections exist (§3).
 */
export function targetsMembershipPlan(value: unknown): boolean {
  return promotionTargetOrDefault(value) === 'membership_plan';
}
