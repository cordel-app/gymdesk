// #893: a **Mandatory** Sellable Item is always part of every Membership Plan.
//
// #832 (migration 200) added `gym_charges.mandatory` and deliberately left it
// unread: "automatic inclusion in a Billing Plan, refusing its removal from
// one, Billing Plan pricing, Membership Plan Benefits and any Insurance Fee
// special case were all declared out of scope, so a path that acts on the flag
// is deciding that behaviour and needs a ticket" (CLAUDE.md). This is that
// ticket, for the Membership Plan Benefits half of it and nothing else: §9
// scopes out Promotion benefits, billing logic and Sellable Item pricing, so
// this module is only consulted by the three Plan benefit sections.
//
// The rule, from the ticket's Core rule:
//
//   > If a Sellable Item is marked `Mandatory`, every Membership Plan must
//   > contain it, and the Membership Plan editor must not allow it to be
//   > removed.
//
// Two decisions are worth writing down, because both are asked as open
// questions in the ticket:
//
//  1. **The server decides, not the editor.** §7 is explicit that the frontend
//     must not be able to bypass the rule by manipulating the request, and
//     CLAUDE.md forbids duplicating business logic in the frontend. So the
//     Plan benefit `GET` reports the mandatory items a Plan is missing as part
//     of the section (`implicit: true`, quantity `MANDATORY_BENEFIT_QUANTITY`)
//     and the `PUT` writes them whether or not the client sent them. The
//     editor's only job is to render a mandatory row without a Remove control
//     and say why — presentation, not enforcement.
//
//  2. **A `PUT` missing a mandatory item preserves it rather than 400s.** §7
//     allows either ("reject the operation or automatically preserve the
//     mandatory item"). Preserving is what makes §5 work on its own — an
//     existing Plan picks the newly mandatory item up the first time any of its
//     sections is saved, instead of a gym owner meeting an error they cannot
//     act on for an item they never chose.
//
// What `Mandatory` does **not** mean is the quantity: §4 leaves that to the
// Plan's own configuration, so a mandatory item already in a Plan keeps the
// quantity it was given and only a *missing* one is defaulted.

import { SellableItemBenefitCategory, classifySellableItem } from './sellableItemClassification';

/**
 * The quantity a mandatory item is added with when a Plan does not have it
 * yet — the "appropriate default configuration" of §5. One, the same value
 * `addBenefitRow()` seeds a hand-picked row with; the item's Frequency is the
 * item's own and is not stored on the benefit row at all.
 */
export const MANDATORY_BENEFIT_QUANTITY = 1;

/**
 * A Sellable Item as the mandatory rule needs to see it. The caller supplies
 * only *candidates* — active, non-deleted items of this gym — because an
 * inactive or soft-deleted item is not something a Plan can be forced to
 * carry: the benefit `PUT` already refuses a newly selected inactive item, and
 * forcing one in would make every Plan save fail on a catalogue change nobody
 * asked for.
 */
export interface MandatorySellableItem {
  id: number;
  name: string;
  type: string;
  billing_frequency: string | null;
  status: string;
  mandatory: boolean | number;
}

/** `tinyint(1)` from MySQL, `boolean` from a literal — one place to read it. */
export function isMandatorySellableItem(item: { mandatory: boolean | number }): boolean {
  return item.mandatory === true || Number(item.mandatory) === 1;
}

/**
 * The mandatory items that belong in one section. Classification is
 * `classifySellableItem()` and nothing else (#550), so an item can never be
 * mandatory in a section it would not otherwise belong to.
 */
export function mandatoryItemsForCategory(
  candidates: MandatorySellableItem[], category: SellableItemBenefitCategory,
): MandatorySellableItem[] {
  return candidates.filter(
    (item) => isMandatorySellableItem(item) && classifySellableItem(item) === category,
  );
}

/** One row of a Plan benefit section, as the API serves it. */
export interface PlanBenefitRow {
  gym_charge_id: number;
  quantity: number;
  gym_charge_name: string;
  gym_charge_type: string;
  gym_charge_billing_frequency: string | null;
  gym_charge_status: string;
  /** `gym_charges.mandatory`, joined — what the editor hides Remove on. */
  gym_charge_mandatory: boolean | number;
  /**
   * True for a mandatory item this Plan has no stored row for yet: the section
   * shows it (§1, §5) and the next save of the section persists it.
   */
  implicit?: boolean;
  [key: string]: unknown;
}

/**
 * The section as it must be presented: the stored rows, plus every mandatory
 * item missing from them. Missing items are appended in catalogue order after
 * the stored ones rather than merged alphabetically — a row the gym configured
 * keeps its position, and §8's "there must only be one Membership Plan entry"
 * is what the `has` check enforces.
 */
export function mergeMandatoryBenefits<T extends PlanBenefitRow>(
  stored: T[], mandatory: MandatorySellableItem[],
): (T | PlanBenefitRow)[] {
  const present = new Set(stored.map((row) => Number(row.gym_charge_id)));
  const missing = mandatory
    .filter((item) => !present.has(Number(item.id)))
    .map((item): PlanBenefitRow => ({
      gym_charge_id: item.id,
      quantity: MANDATORY_BENEFIT_QUANTITY,
      gym_charge_name: item.name,
      gym_charge_type: item.type,
      gym_charge_billing_frequency: item.billing_frequency,
      gym_charge_status: item.status,
      gym_charge_mandatory: 1,
      implicit: true,
    }));
  return [...stored, ...missing];
}

/** What a replace-all `PUT` is about to write. */
export interface PlanBenefitWrite {
  gym_charge_id: number;
  quantity: number;
}

/**
 * The rows a `PUT` must actually insert: what the client sent, plus any
 * mandatory item it left out, at the default quantity. A submitted mandatory
 * item is passed through untouched, quantity included (§4).
 *
 * Returning the merged list rather than an error is decision 2 in the header;
 * the caller reports it back through the section's `GET` shape, so a client
 * that dropped a mandatory item sees it return rather than silently losing it.
 */
export function withMandatoryBenefits(
  submitted: PlanBenefitWrite[], mandatory: MandatorySellableItem[],
): PlanBenefitWrite[] {
  const present = new Set(submitted.map((item) => Number(item.gym_charge_id)));
  return [
    ...submitted,
    ...mandatory
      .filter((item) => !present.has(Number(item.id)))
      .map((item) => ({ gym_charge_id: item.id, quantity: MANDATORY_BENEFIT_QUANTITY })),
  ];
}
