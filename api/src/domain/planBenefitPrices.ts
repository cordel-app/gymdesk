// #916 — what one Sellable Item row of a Membership Plan Benefit section costs,
// before and after the Plan's own treatment of it.
//
// The ticket asks the card to show two amounts per row: the **Original Price**
// ("the normal price of the Sellable Item before applying the Membership Plan
// benefit") and the **Final Price** ("after applying all relevant Membership
// Plan pricing rules"), both VAT-inclusive. Its load-bearing requirement is
// that neither may be a second pricing implementation:
//
//   > Do not implement separate pricing logic for this UI. The Final Price
//   > should reuse the existing pricing/billing calculation so that the
//   > Membership Plan details page cannot show a different amount from the
//   > amount that would actually be billed.
//
// So this module decides nothing about money on its own. `applyLineBenefit()`
// (#896) is the one place an `(action, value)` pair becomes an amount — the very
// function the Billing Simulation's charge builders call — and the gross-up is
// `computePriceFields()`'s, done by the caller before it gets here, exactly as
// `planSimulationItems()` does for the Billing Event Simulation (#915). What is
// left is which amounts to report, and that is the whole of this file.
//
// **Unit and line are both reported, and they are not the same question.** The
// ticket defines the Original Price as the Sellable Item's own price, which is
// the *unit* price, and the row already shows the Quantity beside it; but the
// amount that reaches a billing event is the *line* (`unit × quantity`), which
// is what #915's `regular_price` / `actual_charge` are. Reporting only the unit
// pair would let a quantity-5 row quote €25 next to a simulation charging €125,
// and reporting only the line pair would stop calling the Sellable Item's price
// by its name. Both come from the same `applyLineBenefit()`, so they cannot
// disagree: the unit pair is that function at quantity 1.
//
// Pure — no DB, no HTTP (CLAUDE.md).

import { SellableItemBenefit, applyLineBenefit } from './sellableItemBenefitActions';

/**
 * The four amounts one benefit row reports, all VAT-inclusive euros and all
 * `null` for an item that carries no price at all (a Sellable Item's `amount` is
 * nullable, and the honest answer then is "—", never €0.00 — the same choice
 * `formatPlanCurrentPrice()` makes for a Plan with no price).
 */
export interface PlanBenefitPrices {
  /** The Sellable Item's own price, per unit — the ticket's *Original Price*. */
  original_price_incl_tax: number | null;
  /** That unit price after this row's `(action, value)` pair — its *Final Price*. */
  final_price_incl_tax: number | null;
  /** `unit × quantity` before the treatment — #915's `regular_price`. */
  original_line_price_incl_tax: number | null;
  /** The line after it — what a billing event for this row would charge. */
  final_line_price_incl_tax: number | null;
}

export const NO_PLAN_BENEFIT_PRICES: PlanBenefitPrices = {
  original_price_incl_tax: null,
  final_price_incl_tax: null,
  original_line_price_incl_tax: null,
  final_line_price_incl_tax: null,
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * One row's prices, from its item's **gross** unit price, its quantity and its
 * own pricing treatment.
 *
 * A Membership Plan may configure only `no_benefit`, `waive` and
 * `percentage_discount` (#896 §16), all three of which are proportional — which
 * is why quoting a per-unit final price is exact here rather than an
 * approximation of the line, and why the gross-up before this call is exact too
 * (a percentage of the gross is the gross of the percentage, #915's tax note).
 * A pair outside that set has already been normalized away by
 * `toSellableItemBenefit('plan', …)`, so nothing here has to second-guess it.
 */
export function planBenefitPrices(
  unitPriceInclTax: number | null | undefined,
  quantity: number,
  benefit: SellableItemBenefit,
): PlanBenefitPrices {
  if (unitPriceInclTax == null || !Number.isFinite(unitPriceInclTax)) {
    return { ...NO_PLAN_BENEFIT_PRICES };
  }
  const unit = round2(unitPriceInclTax);
  const units = Number.isFinite(quantity) ? Math.max(0, Math.trunc(quantity)) : 0;
  return {
    original_price_incl_tax: unit,
    final_price_incl_tax: applyLineBenefit(unit, 1, benefit),
    original_line_price_incl_tax: round2(unit * units),
    final_line_price_incl_tax: applyLineBenefit(unit, units, benefit),
  };
}
