// #920 — the Original/Regular and Final Price a configured Product line
// reports, for **both** places a line can be configured.
//
// #916 gave the Membership Plan's three Benefit sections that pair and put the
// two halves of it in `membership-plans.ts`: the gross-up (`computePriceFields`
// over the item's own amount and tax rate) and the amounts themselves
// (`domain/planBenefitPrices.ts` over `applyLineBenefit()`). #919/#920 ask the
// Promotion card's three sections for the very same pair — "Regular Price" and
// "Final Price", both tax-included — with the ticket's own load-bearing clause:
//
//   > Do not introduce separate pricing logic for the Promotion UI. [...] The UI
//   > should consume the same calculated values used by the actual billing
//   > system wherever possible.
//
// So the wiring moves here rather than being copied: one gross-up, one amount
// decider, three callers (`membership-plans.ts`, `promotion-details.ts` and —
// since #924 stage 1 — `assigned-plan-snapshot.ts`, which prices an
// assignment's frozen lines through `productBenefitPrices()` below). The
// only thing a caller supplies beyond its rows is its **context** — a Plan may
// configure three of the five actions and a Promotion all five (#896 §16) — and
// `toProductBenefit()` is what keeps a pair from being read in the wrong
// one.
//
// **What "tax included" means for the two amount-taking actions.** The three a
// Plan can configure are proportional, so grossing up first and applying the
// treatment after is exact (#915's tax note). `fixed_discount` and `fixed_price`
// are not proportional, and a Promotion can configure both: the configured
// number is taken at face value as the VAT-inclusive amount the gym typed —
// *Fixed Price 500* reads €500.00, the same figure the Membership Fee Promotion
// row beside it shows and the same one the Billing Simulation applies to the
// stored amount (`buildItemSingleCharge` / `buildPeriodicCharge`, which are tax
// agnostic). It is deliberately not grossed up a second time, which would quote
// a price nobody configured.

import { computePriceFields } from './products';
import { PlanBenefitPrices, planBenefitPrices } from '../domain/planBenefitPrices';
import {
  ProductBenefitContext,
  toProductBenefit,
} from '../domain/productBenefitActions';

/**
 * One benefit row as the pricing needs it: the quantity and `(action, value)`
 * pair it stores, plus the Product's price columns from its own join.
 *
 * The price columns are optional because a row may have none to join — a
 * Mandatory item a Plan has no stored row for yet (#893 §5) is priced from the
 * active catalogue instead, which is what `fallback` is for.
 */
export interface BenefitPricingRow {
  gym_charge_id: number | string;
  quantity: number | string;
  action?: unknown;
  value?: unknown;
  gym_charge_amount?: string | number | null;
  gym_charge_tax_behavior?: string | null;
  gym_charge_tax_rate_percent?: string | number | null;
}

/** The catalogue row a benefit row with no joined price falls back to. */
export interface BenefitPricingFallback {
  id: number | string;
  amount?: string | number | null;
  tax_behavior?: string | null;
  tax_rate_percent?: string | number | null;
}

/**
 * One benefit row's item price, **grossed up** — the amount every one of these
 * projections is denominated in (#915's tax note, #817 for why the arithmetic is
 * the server's and never the page's). `null` for an item that carries no price
 * at all, which is not the same as €0.00: a priced-at-nothing row bills nothing
 * and reads as "—".
 *
 * The rate may be missing while the amount is not (a gym with no tax rate
 * configured), and the stored amount is then the honest gross — exactly how
 * `formatPlanCurrentPrice()` falls back for the Plan's own price.
 */
export function grossBenefitUnitPrice(
  row: BenefitPricingRow, fallback?: BenefitPricingFallback,
): number | null {
  const amount = row.gym_charge_amount ?? fallback?.amount ?? null;
  if (amount == null) return null;
  return computePriceFields({
    amount,
    tax_rate_percent: row.gym_charge_tax_rate_percent ?? fallback?.tax_rate_percent ?? null,
    tax_behavior: row.gym_charge_tax_behavior ?? fallback?.tax_behavior ?? 'inclusive',
  }).amount_incl_tax ?? Number(amount);
}

/**
 * One row's four amounts — the single-row entry point every caller of this
 * module ends up at.
 *
 * #924 stage 1 is why it is exported: an Assigned Plan's benefit sections are
 * not a section-shaped list of catalogue joins but a *snapshot*, whose price is
 * the one frozen on the line (`user_membership_{session,oneoff,periodical}`.
 * `unit_price`) rather than the Product's current `amount`. It passes that
 * frozen figure as the row's own amount and gets the same pair of prices every
 * other surface quotes, which is the ticket's requirement — "the same shared
 * grid/layout should be reused rather than implementing an Assigned Plan-specific
 * version", and no third pricing implementation.
 */
export function productBenefitPrices(
  context: ProductBenefitContext,
  row: BenefitPricingRow,
  fallback?: BenefitPricingFallback,
): PlanBenefitPrices {
  return planBenefitPrices(
    grossBenefitUnitPrice(row, fallback),
    Number(row.quantity) || 1,
    toProductBenefit(context, row.action, row.value),
  );
}

/**
 * A section as its card renders it: every row plus the Original/Regular and
 * Final Price it must show, VAT included.
 *
 * The amounts are `domain/planBenefitPrices.ts`'s, over the same
 * `applyLineBenefit()` the Billing Simulation's charge builders use, so a
 * Benefit section and the Billing Event Simulation beside it on the very same
 * card cannot quote one line two ways. Nothing is stored: like
 * `example_timeline` and `billing_event_simulation`, these are computed on
 * every read.
 */
export function withProductBenefitPrices<T extends BenefitPricingRow>(
  context: ProductBenefitContext,
  rows: T[],
  catalogue?: BenefitPricingFallback[],
): (T & PlanBenefitPrices)[] {
  const byId = new Map((catalogue ?? []).map((item) => [Number(item.id), item]));
  return rows.map((row) => ({
    ...row,
    ...productBenefitPrices(context, row, byId.get(Number(row.gym_charge_id))),
  }));
}
