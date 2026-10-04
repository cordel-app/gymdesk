// #959 — a Product configured inside a **Promotion** carries a
// **Requirement**: whether the member must take it with the Promotion, or may
// decline it.
//
//   SESSION BENEFITS
//   PRODUCT                   QUANTITY   FREQUENCY   PROMOTION   REQUIREMENT
//   Gym Membership Fee           1       Month       50%         Mandatory
//   Locker Fee                   1       Month       50%         Optional
//
// reads "both are discounted 50%, and the locker is the one the member may say
// no to".
//
// **What this is not.** `products.mandatory` (#832/#893) already exists and
// answers a different question on a different row: it is a property of the
// gym's **catalogue** item, and its one meaning is that the item is forced into
// every *Membership Plan* benefit section (`domain/mandatoryPlanBenefits.ts`).
// This column is a property of the **relationship** between one Promotion and
// one Product, exactly as #896's `(action, value)` pair is and for the
// same reason: the same item may be mandatory in one Promotion and optional in
// another, and `products` learns nothing from either. The two never appear
// in one grid — a Promotion section passes no `enforceMandatory`, so the
// catalogue flag's `Mandatory` pill belongs to the Plans page alone.
//
// **Promotions only, this ticket.** The issue asks for the same flag on
// Membership Plan items; the owner's answer on the thread excludes Plans
// ("Exclude Membership plans from this ticket"), excludes the Membership Fee
// Benefit ("Q3 — can the Membership Fee be Optional? No.") and defers the
// member's own enabled/disabled choice and its billing effect to the assignment
// process, which is "out of scope of this ticket". So the column lives on the
// three `promotion_*` tables and the three assignment-side snapshot tables, and
// **nothing reads it yet**: no pricing path, no projection, no apply path. A
// code path that acts on it beyond configuring, reporting and snapshotting it is
// deciding the assignment behaviour and needs a ticket.
//
// It is snapshotted all the same, for the Assigned Plan rule (CLAUDE.md, #635
// §16/§17): a Requirement that reached only the catalogue would be a
// configuration no existing application could have been agreed with, and the
// screen that will offer the member the choice reads the application's own
// snapshot rather than a Promotion that may have been edited since.
//
// A new value goes in **three** places: `PROMOTION_ITEM_REQUIREMENTS` below, the
// `chk_<table>_requirement` CHECK beside it (current definition: migration 207)
// and the browser's mirror in `apps/admin/src/lib/promotionItemRequirement.ts`.
// `promotion-item-requirement.unit.test.ts` asserts the first two agree and
// `promotion-item-requirement-ui.test.ts` the third.
//
// Pure — no DB, no HTTP (CLAUDE.md).

/** What a Promotion's Product line may be configured as, in dropdown order. */
export const PROMOTION_ITEM_REQUIREMENTS = ['mandatory', 'optional'] as const;

export type PromotionItemRequirement = (typeof PROMOTION_ITEM_REQUIREMENTS)[number];

/**
 * What every line written before this ticket means, and what a new one starts
 * at: the member takes the item with the Promotion.
 *
 * It is `mandatory` rather than `optional` because that is the behaviour the
 * product has today — an applied Promotion grants everything it configures, and
 * nothing offers the member a choice. A default of `optional` would announce a
 * choice the assignment process does not yet implement, and migration 207's
 * backfill would make that claim about every row already stored. Letting an item
 * be declined is the deliberate act, so it is the one that has to be configured.
 */
export const DEFAULT_PROMOTION_ITEM_REQUIREMENT: PromotionItemRequirement = 'mandatory';

export function isPromotionItemRequirement(value: unknown): value is PromotionItemRequirement {
  return typeof value === 'string'
    && (PROMOTION_ITEM_REQUIREMENTS as readonly string[]).includes(value);
}

/**
 * A stored column value, normalized. Defensive in the way
 * `toProductBenefit()` is: the column is NOT NULL with a default, but a
 * read must still report something usable for a row written in the instant
 * between migration 207's two statements, and the safe answer is the one that
 * grants what the Promotion configured.
 */
export function toPromotionItemRequirement(value: unknown): PromotionItemRequirement {
  return isPromotionItemRequirement(value) ? value : DEFAULT_PROMOTION_ITEM_REQUIREMENT;
}

/** `mandatory, optional` — for a route's 400 message. */
export function describePromotionItemRequirements(): string {
  return PROMOTION_ITEM_REQUIREMENTS.join(', ');
}

/**
 * What a replace-all `PUT` should do with one submitted line's Requirement.
 *
 * The three answers are #896's and #918's, for their reason: the three Promotion
 * benefit section `PUT`s delete and re-insert the whole section on every save,
 * so a client that sends `product_id` + `quantity` alone — any client written
 * before this ticket, and every test that predates it — must keep the
 * Requirement the line is stored with rather than silently resetting it to the
 * default. Clearing is not a thing you can do to this column (it is NOT NULL);
 * changing it is the explicit `requirement: 'optional'`.
 *
 *   `keep`  — the request named no Requirement at all.
 *   `set`   — an explicit, valid value.
 *   `error` — anything else, which is a 400 and never a coercion.
 */
export type PromotionItemRequirementInput =
  | { keep: true; requirement?: undefined; error?: undefined }
  | { keep: false; requirement: PromotionItemRequirement; error?: undefined }
  | { keep?: undefined; requirement?: undefined; error: string };

export function parsePromotionItemRequirementInput(item: unknown): PromotionItemRequirementInput {
  const raw = (item as { requirement?: unknown } | null | undefined)?.requirement;
  if (raw === undefined || raw === null || raw === '') return { keep: true };
  if (isPromotionItemRequirement(raw)) return { keep: false, requirement: raw };
  return { error: `requirement must be one of: ${describePromotionItemRequirements()}` };
}
