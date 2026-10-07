// #893: a **Mandatory** Product is always part of every Membership Plan.
//
// #832 (migration 200) added `products.mandatory` and deliberately left it
// unread: "automatic inclusion in a Billing Plan, refusing its removal from
// one, Billing Plan pricing, Membership Plan Benefits and any Insurance Fee
// special case were all declared out of scope, so a path that acts on the flag
// is deciding that behaviour and needs a ticket" (CLAUDE.md). This is that
// ticket, for the Membership Plan Benefits half of it and nothing else: §9
// scopes out Promotion benefits, billing logic and Product pricing, so
// this module is only consulted by the three Plan benefit sections.
//
// The rule, from the ticket's Core rule:
//
//   > If a Product is marked `Mandatory`, every Membership Plan must
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

import { ProductBenefitCategory, classifyProduct } from './productClassification';
import { DEFAULT_BENEFIT_ACTION, ProductBenefit } from './productBenefitActions';
import { SessionBenefitFrequency } from './sessionBenefitFrequency';

/**
 * The quantity a mandatory item is added with when a Plan does not have it
 * yet — the "appropriate default configuration" of §5. One, the same value
 * `addBenefitRow()` seeds a hand-picked row with; the item's Frequency is the
 * item's own and is not stored on the benefit row at all.
 */
export const MANDATORY_BENEFIT_QUANTITY = 1;

/**
 * A Product as the mandatory rule needs to see it. The caller supplies
 * only *candidates* — active, non-deleted items of this gym — because an
 * inactive or soft-deleted item is not something a Plan can be forced to
 * carry: the benefit `PUT` already refuses a newly selected inactive item, and
 * forcing one in would make every Plan save fail on a catalogue change nobody
 * asked for.
 */
export interface MandatoryProduct {
  id: number;
  name: string;
  type: string;
  billing_frequency: string | null;
  status: string;
  mandatory: boolean | number;
  /**
   * #916 — the item's price columns, so an implicit row quotes its Original and
   * Final Price like a stored one. Optional because a caller that does not
   * price the section (the write path's own validation) has no reason to read
   * them; a row built without them reports no price, which reads as "—" rather
   * than as €0.00.
   */
  amount?: string | number | null;
  tax_behavior?: string | null;
  tax_rate_percent?: string | number | null;
}

/** `tinyint(1)` from MySQL, `boolean` from a literal — one place to read it. */
export function isMandatoryProduct(item: { mandatory: boolean | number }): boolean {
  return item.mandatory === true || Number(item.mandatory) === 1;
}

/**
 * The mandatory items that belong in one section. Classification is
 * `classifyProduct()` and nothing else (#550), so an item can never be
 * mandatory in a section it would not otherwise belong to.
 */
export function mandatoryItemsForCategory(
  candidates: MandatoryProduct[], category: ProductBenefitCategory,
): MandatoryProduct[] {
  return candidates.filter(
    (item) => isMandatoryProduct(item) && classifyProduct(item) === category,
  );
}

/** One row of a Plan benefit section, as the API serves it. */
export interface PlanBenefitRow {
  product_id: number;
  quantity: number;
  product_name: string;
  product_type: string;
  product_billing_frequency: string | null;
  product_status: string;
  /** `products.mandatory`, joined — what the editor hides Remove on. */
  product_mandatory: boolean | number;
  /**
   * True for a mandatory item this Plan has no stored row for yet: the section
   * shows it (§1, §5) and the next save of the section persists it.
   */
  implicit?: boolean;
  /**
   * #896 stage 2 — the row's pricing treatment. A stored row reports what it
   * holds; an implicit one reports the neutral default, because Mandatory says
   * the item must be *there*, never what it costs.
   */
  action?: string;
  value?: number | null;
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
  stored: T[], mandatory: MandatoryProduct[],
): (T | PlanBenefitRow)[] {
  const present = new Set(stored.map((row) => Number(row.product_id)));
  const missing = mandatory
    .filter((item) => !present.has(Number(item.id)))
    .map((item): PlanBenefitRow => ({
      product_id: item.id,
      quantity: MANDATORY_BENEFIT_QUANTITY,
      product_name: item.name,
      product_type: item.type,
      product_billing_frequency: item.billing_frequency,
      product_status: item.status,
      product_mandatory: 1,
      // #918: no row exists, so no renewal Frequency was configured — the
      // allowance is a one-time one until someone saves the section and sets one.
      frequency: null,
      // #916: the same three price columns a stored row carries from its own
      // join, under the same names, so one pricing pass serves both kinds of
      // row and an implicit item cannot end up quoted differently.
      product_amount: item.amount ?? null,
      product_tax_behavior: item.tax_behavior ?? null,
      product_tax_rate_percent: item.tax_rate_percent ?? null,
      implicit: true,
      // #896 stage 2: no row exists, so nothing was configured — the item is
      // included at its own price until someone saves the section and edits it.
      action: DEFAULT_BENEFIT_ACTION,
      value: null,
      // #1184 stage 2: no row exists, so nothing was configured — mandatory, the default.
      mandatory: true,
    }));
  return [...stored, ...missing];
}

/** What a replace-all `PUT` is about to write. */
export interface PlanBenefitWrite {
  product_id: number;
  quantity: number;
  /**
   * #896 stage 2 — the pricing treatment the request named for this line.
   * Absent (or `null`) means it named none, which is not `no_benefit`: the
   * route resolves it against what the line is already stored with, so a save
   * that never mentions the pair cannot rewrite it (see
   * `parseProductBenefitInput`). A mandatory item re-added below carries
   * none for exactly that reason — Mandatory says the item must be there, never
   * what it costs, so preserving it can never change what it was agreed at.
   */
  benefit?: ProductBenefit | null;
  /**
   * #918 — the Session Benefit's renewal Frequency the request named, with the
   * same three-way encoding as `benefit`: absent means the request named none
   * and the line keeps what it is stored with, `null` is the explicit `—`. Only
   * the session section has the column; the other two ignore it.
   */
  frequency?: SessionBenefitFrequency | null;
  /**
   * #1184 stage 2 — the line's own Mandatory Yes/No. Absent means the request
   * named none and the line keeps what it is stored with; a mandatory *Product*
   * re-added below carries none either, so preserving it never changes it.
   */
  mandatory?: boolean;
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
  submitted: PlanBenefitWrite[], mandatory: MandatoryProduct[],
): PlanBenefitWrite[] {
  const present = new Set(submitted.map((item) => Number(item.product_id)));
  return [
    ...submitted,
    ...mandatory
      .filter((item) => !present.has(Number(item.id)))
      .map((item) => ({ product_id: item.id, quantity: MANDATORY_BENEFIT_QUANTITY })),
  ];
}
