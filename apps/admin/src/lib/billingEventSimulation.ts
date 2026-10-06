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

import type {
  ExampleTimelineCycleInfo,
  ExampleTimelineRowCycle,
} from './exampleTimeline';

/** Why a line's charge differs from its regular price. */
export interface BillingEventSimulationBenefit {
  source: 'promotion' | 'membership_plan' | 'personal';
  name: string | null;
  action: 'no_benefit' | 'waive' | 'percentage_discount' | 'fixed_discount' | 'fixed_price' | 'included';
  value: number | null;
  period_status: string | null;
}

export interface BillingEventSimulationLine {
  kind: 'membership_fee' | 'product';
  label: string;
  product_id: number | null;
  /** #832 — the line exists because the Product is Mandatory. */
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
  /**
   * #1130 stage 3 — which iteration of the contract's configured cycle this
   * billing date falls in, or `null` where there is none to name it with. The
   * server's answer (`planDurationCycleIteration()`), never derived here: the
   * cards must group by the iterations the engine bills, not by a count the
   * page keeps for itself.
   */
  cycle?: number | null;
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
  /**
   * #1130 stage 3 — the cycle those dates belong to, as the engine reports it;
   * `null` for a contract with no Billing & Duration, for a Promotion and on an
   * unavailable projection. It is the very value the Membership Fee Simulation
   * beside it carries, so `exampleTimelineCycleNote()` words both markers.
   */
  cycle?: ExampleTimelineCycleInfo | null;
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


/* ── Collapsible billing-period cards (#955) ──────────────────────────────── */
//
// The section is one collapsible card per billing *date*, so the three pure
// decisions that layout needs live here rather than inside the component: which
// of the Example Timeline's three tones a line reads in, which cards start
// open, and whether the global control currently says *Expand all* or
// *Collapse all*. None of them touches an amount, a date or a treatment — those
// are the server's and are only formatted.

/**
 * The Example Timeline's three tones (`ExampleTimelineTone`), spelled here so
 * this module stays JSX-free; the component maps them onto that table's own
 * exported colours rather than declaring any of its own (#955: "do not
 * introduce new colors specifically for this component").
 */
export type SimulationLineTone = 'free' | 'benefit' | 'regular';

/**
 * What a line's row is drawn in, in the Example Timeline's own semantics: green
 * for an occurrence that charges nothing, amber for one a benefit or a Pre-paid
 * Duration changed, grey for an ordinary charge.
 *
 * It reads the treatment the server already reported — a `waive`d (or the
 * pre-#896 `included`) line is free, a line carrying any other action or the
 * `prepaid_periods` count of #946's lump is the promotional tone — and never
 * compares amounts, because €0.00 is also what an item with no price costs.
 */
export function simulationLineTone(line: BillingEventSimulationLine): SimulationLineTone {
  const actions = line.benefits.map((b) => b.action);
  if (actions.some((a) => a === 'waive' || a === 'included')) return 'free';
  if (actions.some((a) => a !== 'no_benefit')) return 'benefit';
  if (line.prepaid_periods != null) return 'benefit';
  return 'regular';
}

/**
 * The initial state of the cards: the **first** billing period open and every
 * other one closed (#955 — "the first billing period should be expanded by
 * default"), keyed by the group's own date.
 */
export function initialExpandedPeriods(
  dates: readonly BillingEventSimulationDate[],
): Record<string, boolean> {
  return Object.fromEntries(dates.map((group, i) => [group.date, i === 0]));
}

/** Every card open or closed — what the global control applies. */
export function allExpandedPeriods(
  dates: readonly BillingEventSimulationDate[],
  expanded: boolean,
): Record<string, boolean> {
  return Object.fromEntries(dates.map((group) => [group.date, expanded]));
}

/**
 * Whether every card is currently open, which is what the global control
 * reflects ("the global control always reflects whether all cards are currently
 * expanded"). A section with no periods is not "all expanded" — its control is
 * not rendered at all.
 */
export function everyPeriodExpanded(
  dates: readonly BillingEventSimulationDate[],
  expanded: Record<string, boolean>,
): boolean {
  return dates.length > 0 && dates.every((group) => expanded[group.date] === true);
}


/* ── #1130 stage 3: the cycle a billing-period card belongs to ─────────────── */
//
// Stage 2 gave the Membership Fee Simulation a `Cycle` column, one thin line per
// displayed iteration and a marker saying whether the cycle starts again. §2 of
// the ticket asks the Billing Event Simulation for the same story over its
// existing cards — "a lightweight presentation layer around the existing
// billing-event cards", no table, no bordered container, no horizontal divider.
//
// So this is the card-shaped counterpart of `exampleTimelineRowCycle()`, and it
// derives **nothing** about the cycle: which iteration a date belongs to is the
// server's `group.cycle`, and all that is left is where one iteration's run of
// cards ends so its line can stop short of the next one's.

/**
 * The cycle gutter of each billing-period card, in order: the iteration's
 * number on the **first** card of its run (and on the first card rendered,
 * which for an Assigned Plan's forecast may be mid-iteration), and whether the
 * thin line beside it stops here so the next iteration's does not touch it.
 *
 * `null` for a card that belongs to no displayed iteration — the regular billing
 * dates a non-repeating contract settles into after its single pass, which carry
 * neither a number nor a line, exactly as the fee table's trailing rows do.
 *
 * The cell shape is the fee table's own (`ExampleTimelineRowCycle`), because it
 * is one grouping language rendered over two layouts.
 */
export function billingEventCycleCells(
  dates: readonly Pick<BillingEventSimulationDate, 'cycle'>[],
): (ExampleTimelineRowCycle | null)[] {
  return dates.map((group, index) => {
    const iteration = group.cycle ?? null;
    if (iteration == null) return null;
    const previous = dates[index - 1]?.cycle ?? null;
    const next = dates[index + 1]?.cycle ?? null;
    return {
      label: index === 0 || previous !== iteration ? String(iteration) : null,
      endsSegment: next !== iteration,
    };
  });
}
