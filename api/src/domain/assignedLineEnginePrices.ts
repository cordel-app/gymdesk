// #2624 stage 3 (§2) — an Assigned Plan line's Final Price includes the
// Promotion Benefit, and the figure is the billing engine's.
//
// The grid's Final Price used to be `planBenefitPrices()`: the frozen unit price
// after the line's own treatment and its Direct Discount (#2490). A Promotion
// grant covering the line was named beside it (Applied Promotion / Promotion
// Benefit, #2483) but left out of the amount, while the engine — and so every
// Billing Event — folds the grant in (`resolveCoveredCharge()`,
// `allocateSessionUnits()`). The card therefore quoted one price and billed
// another.
//
// This module decides nothing about money. It reads what the engine already
// charged (or will charge) a line for the cycle that matters today and reports
// that figure, for the lines a Promotion actually touches in that cycle. A line
// no Promotion covers keeps `planBenefitPrices()`'s figures, which are the
// engine's own arithmetic for it (the treatment, then the Direct Discount), so
// there is one answer either way and no benefit can be applied twice.
//
// Which cycle: the latest occurrence on or before today (the cycle being
// billed now, and the only occurrence of a one-off line already charged), else
// the first one after today (a line not billed yet). A prorated first charge
// (#1867 stage 4) is skipped: it is a part-period, not the line's price.
//
// Pure — no DB, no HTTP (CLAUDE.md).

import type { PlanBenefitPrices } from './planBenefitPrices';
import type { BillingSimulationResult, SimulationLine } from './billingSimulation';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A product line as the engine priced it on one date. */
export interface EngineLineCharge {
  date: string;
  quantity: number;
  regular_price: number;
  actual_charge: number;
  /** True when a Promotion grant changed (or covered) this charge. */
  promoted: boolean;
}

/**
 * A line's identity in the engine's output: its Product and, for an Individual Product
 * held as one line per member (#2657 stage 3), the member. The engine merges a Plan
 * benefit and every grant on the same Product into that line (`collectBillableItems()`).
 */
export const engineLineKey = (productId: number, memberId: number | null | undefined): string =>
  `${productId}:${memberId ?? ''}`;

/** One charge per line (`engineLineKey()`), for the cycle that matters on `today`. */
export function currentProductCharges(
  simulation: BillingSimulationResult, today: string,
): Map<string, EngineLineCharge> {
  const byProduct = new Map<string, { past: EngineLineCharge | null; future: EngineLineCharge | null }>();
  if (!simulation.available) return new Map();
  const day = today.slice(0, 10);
  for (const section of simulation.sections) {
    for (const event of section.events) {
      for (const line of event.lines as SimulationLine[]) {
        if (line.kind !== 'product' || line.product_id == null) continue;
        if (line.proration) continue;
        const charge: EngineLineCharge = {
          date: event.date,
          quantity: Number(line.quantity),
          regular_price: Number(line.regular_price),
          actual_charge: Number(line.actual_charge),
          promoted: line.benefits.some((b) => b.source === 'promotion'),
        };
        const key = engineLineKey(line.product_id, line.assigned_member_id);
        const slot = byProduct.get(key) ?? { past: null, future: null };
        if (event.date <= day) {
          if (!slot.past || event.date > slot.past.date) slot.past = charge;
        } else if (!slot.future || event.date < slot.future.date) {
          slot.future = charge;
        }
        byProduct.set(key, slot);
      }
    }
  }
  const out = new Map<string, EngineLineCharge>();
  for (const [productId, slot] of byProduct) {
    const chosen = slot.past ?? slot.future;
    if (chosen) out.set(productId, chosen);
  }
  return out;
}

/** The two figures of a benefit row the overlay may replace. */
export type FinalPriceFields = Pick<PlanBenefitPrices, 'final_price_incl_tax' | 'final_line_price_incl_tax'>;

/**
 * A row's Final Price with the Promotion Benefit in it: when a Promotion touched
 * the Product's charge, the row's Original Price scaled by what the engine
 * actually charged over what it would have charged at the regular price; else
 * the row's own figures.
 *
 * A ratio rather than the engine's amount, for two reasons. The engine runs in
 * the frozen amounts the assignment is billed (`assignmentBillingEventSimulation`'s
 * tax note) while the grid quotes them VAT-inclusive, and the gross-up is one
 * factor per line, so the ratio carries over exactly — including a Promotion's
 * fixed amount, which the engine applied to that same frozen figure. And the
 * engine line may count more units than the row (a renewing Session Benefit
 * reports every renewal in the cycle, #918), which a ratio is indifferent to.
 */
export function finalPriceWithPromotion(
  row: Pick<PlanBenefitPrices, 'original_price_incl_tax' | 'original_line_price_incl_tax'> & FinalPriceFields,
  charge: EngineLineCharge | undefined,
): FinalPriceFields {
  const own = { final_price_incl_tax: row.final_price_incl_tax, final_line_price_incl_tax: row.final_line_price_incl_tax };
  if (!charge || !charge.promoted) return own;
  if (row.original_price_incl_tax == null || row.original_line_price_incl_tax == null) return own;
  if (!(charge.regular_price > 0)) return own;
  const factor = Math.max(0, charge.actual_charge) / charge.regular_price;
  return {
    final_price_incl_tax: round2(row.original_price_incl_tax * factor),
    final_line_price_incl_tax: round2(row.original_line_price_incl_tax * factor),
  };
}
