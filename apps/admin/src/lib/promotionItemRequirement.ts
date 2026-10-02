// #959 — a Sellable Item configured inside a **Promotion** carries a
// **Requirement**: `Mandatory` (the member takes it with the Promotion) or
// `Optional` (the member may decline it when the Promotion is assigned).
//
// Mirrored from `api/src/domain/promotionItemRequirement.ts`, which is what
// actually enforces it (a frontend-only list is not a rule) and what the
// `chk_<table>_requirement` CHECK of migration 207 backs up. This copy exists
// for the same reason `lib/sellableItemBenefitActions.ts` and
// `lib/sessionBenefitFrequency.ts` do: the editor has to render the options and
// must not spell the list out inline. A new value therefore goes in the API
// module, its CHECK, *and* here — `promotion-item-requirement-ui.test.ts` fails
// if this copy drifts.
//
// Deliberately **not** `gym_charges.mandatory` (#832/#893), which is a different
// flag on a different row: that one is a property of the gym's catalogue item
// and means "this item is forced into every Membership Plan benefit section".
// This one is a property of one Promotion's line. The two never share a grid —
// the catalogue flag's `Mandatory` pill is `enforceMandatory`, which the
// Promotion sections do not pass.
//
// The labels are locale keys the owning page resolves (`promotions.item_requirement_*`),
// so nothing about wording lives here.

export type PromotionItemRequirement = 'mandatory' | 'optional';

/** What the Requirement select offers, in order. */
export const PROMOTION_ITEM_REQUIREMENTS: readonly PromotionItemRequirement[] = [
  'mandatory',
  'optional',
];

/**
 * What a line written before #959 holds and what a new one starts at: the member
 * takes the item with the Promotion, which is what every applied Promotion does
 * today. Letting an item be declined is the deliberate act, so it is the one
 * that has to be chosen.
 */
export const DEFAULT_PROMOTION_ITEM_REQUIREMENT: PromotionItemRequirement = 'mandatory';

export function isPromotionItemRequirement(value: unknown): value is PromotionItemRequirement {
  return typeof value === 'string'
    && (PROMOTION_ITEM_REQUIREMENTS as readonly string[]).includes(value);
}

/** A value from the API or the select, normalized — never `undefined` in a cell. */
export function toPromotionItemRequirement(value: unknown): PromotionItemRequirement {
  return isPromotionItemRequirement(value) ? value : DEFAULT_PROMOTION_ITEM_REQUIREMENT;
}

/** The locale key for one value, resolved in the owning page's namespace. */
export function promotionItemRequirementLabelKey(value: unknown): string {
  return `item_requirement_${toPromotionItemRequirement(value)}`;
}
