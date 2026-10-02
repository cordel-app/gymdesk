// The wire shape of a **Billing Event Simulation**
// (`api/src/domain/billingEventSimulation.ts`), and the one label that reads a
// line's price — shared by the two cards that render the section (the Membership
// Plan's and, since #922, the Promotion's).
//
// Pure and JSX-free, so a page's own declaration module can import it without
// pulling the component in; the component beside it is the look.
//
// Every amount is the server's, VAT included. Which events exist, which date
// each falls on, which benefit applies and what it costs are billing rules and
// are never re-derived here.

/** Why a line's charge differs from its regular price. */
export interface BillingEventSimulationBenefit {
  source: 'promotion' | 'membership_plan' | 'personal';
  name: string | null;
  action: 'no_benefit' | 'waive' | 'percentage_discount' | 'fixed_discount' | 'fixed_price' | 'included';
  value: number | null;
  period_status: string | null;
}

export interface BillingEventSimulationLine {
  kind: 'membership_fee' | 'sellable_item';
  label: string;
  gym_charge_id: number | null;
  /** #832 — the line exists because the Sellable Item is Mandatory. */
  mandatory: boolean;
  quantity: number;
  unit_price: number;
  regular_price: number;
  actual_charge: number;
  /**
   * #946 — how many Pre-paid periods this line covers, on the one line that
   * ever covers more than one: the Membership Fee charge that collects a Plan's
   * Pre-paid Duration up front. `null` on every other line, including every
   * ordinary fee cycle, so the note appears exactly where the server put it.
   */
  prepaid_periods: number | null;
  benefits: BillingEventSimulationBenefit[];
}

export interface BillingEventSimulationDate {
  date: string;
  lines: BillingEventSimulationLine[];
  total: number;
}

export interface BillingEventSimulationData {
  available: boolean;
  reason: string | null;
  currency: string;
  anchor_date: string | null;
  horizon_date: string | null;
  tax_included: boolean;
  truncated: boolean;
  dates: BillingEventSimulationDate[];
  total: number;
}

/**
 * The `simulation_price_*` key describing what a line's price is, in the
 * tickets' own vocabulary: a line at its regular price reads "Regular price", a
 * waived one reads "Waived", and a discounted one names the discount. The key
 * is resolved in the calling page's namespace, which is why a Plan can say
 * *Benefit* where a Promotion says *Promotion* for the very same action.
 *
 * All five actions are mapped even though a Membership Plan can only configure
 * three of them (#896 §16) — the shape is the shared engine's, and a Promotion
 * configures all five.
 */
export function simulationPriceLabelKey(
  benefit: BillingEventSimulationBenefit | undefined,
): string {
  switch (benefit?.action) {
    case undefined:
    case 'no_benefit': return 'simulation_price_regular';
    case 'waive':
    case 'included': return 'simulation_price_waived';
    case 'percentage_discount': return 'simulation_price_percentage';
    case 'fixed_discount': return 'simulation_price_fixed_discount';
    case 'fixed_price': return 'simulation_price_fixed_price';
    default: return 'simulation_price_regular';
  }
}

