// The wire shape of an **Example Timeline**
// (`api/src/domain/exampleTimeline.ts`), and the two pure rules that read one
// of its rows — shared by the cards that render the section: the Membership
// Plan's (#818) and, since #924 stage 3, the Assigned Plan's *Membership Fee
// Simulation*.
//
// Pure and JSX-free, so a page's own declaration module can import it without
// pulling the shared table in; `components/ExampleTimeline.tsx` beside it is
// the look.
//
// Every amount is the server's, VAT included. Which period is Free /
// Pre-paid / Pay / Bonus, what it charges and whether it charges at all are
// billing rules and are never re-derived here.

/** The one empty marker the admin uses for "no value", shared with the pages. */
const EMPTY_VALUE = '—';

/**
 * What a row's Status names: the Plan's (or the assignment's) own Billing &
 * Duration, or — where an applied Promotion governs the date — that
 * Promotion's own period. A Membership Plan preview can only ever produce the
 * first five; an Assigned Plan can produce all nine.
 */
export type ExampleTimelineStatus =
  | 'free_plan' | 'prepaid_plan' | 'pay_plan' | 'bonus_plan'
  | 'free_promotion' | 'pay_promotion' | 'prepaid_promotion' | 'bonus_promotion'
  | 'pay_regular';

export interface ExampleTimelinePeriodRow {
  period: number;
  status: ExampleTimelineStatus;
  startsOn: string;
  /** `null` on a trailing open-ended period — billing continues. */
  endsOn: string | null;
  /** The VAT-inclusive price this period charges, `null` for no charge. */
  amount: number | null;
  waived: boolean;
  /**
   * #946 — how many Pre-paid periods `amount` covers, on the single row that
   * collects a Pre-paid Duration up front; `null` on every other row.
   */
  prepaidPeriods: number | null;
}

export interface ExampleTimelineProjection {
  available: boolean;
  reason: string | null;
  currency: string;
  anchorDate: string | null;
  periods: ExampleTimelinePeriodRow[];
  /**
   * #1130 stage 2 — the cycle the periods belong to, as the engine reports it;
   * `null` for a contract with no configured durations and on an unavailable
   * projection. See `exampleTimelineRowCycles()` at the end of this module.
   */
  cycle?: ExampleTimelineCycleInfo | null;
}

/**
 * The Billing cell. A waived period (Free, Bonus, or a Pre-paid one already
 * collected) reads "No charge"; a charged one quotes the price as the server
 * computed it, VAT included — never recomputed here (#817). A row with no
 * price to quote reads as the admin's empty value rather than as €0.00, which
 * would claim the member is charged nothing.
 *
 * #946 — the first Pre-paid period charges the fee for every period it pays
 * for, so its cell quotes that amount (the server's, again) and names the
 * count beside it: `€210.00 VAT included · 3 periods prepaid`. Without the
 * note the row would read as a single period costing three times the price.
 */
export function formatExampleTimelineBilling(
  row: Pick<ExampleTimelinePeriodRow, 'amount' | 'waived'>,
  /** "No charge". */
  noChargeLabel: string,
  /** "VAT included". */
  taxIncludedSuffix: string,
  /** The prepaid note, already pluralised by the page; `null` otherwise. */
  prepaidNote?: string | null,
): string {
  if (row.waived) return noChargeLabel;
  if (row.amount == null) return EMPTY_VALUE;
  const price = `€${row.amount.toFixed(2)} ${taxIncludedSuffix}`;
  return prepaidNote ? `${price} · ${prepaidNote}` : price;
}

/**
 * Row tinting, the Promotion table's own three tones: green for a period that
 * charges nothing, grey for the regular ones, amber for the configured paid
 * ones in between.
 *
 * It reads the row rather than its status alone since #946: the first Pre-paid
 * period *charges* (it collects the whole Pre-paid Duration), and green is
 * this table's "no charge" tone — so a charged period of a configured duration
 * takes the amber one, exactly as a Pay period of a Paid Duration does.
 */
export function exampleTimelineRowTone(
  row: Pick<ExampleTimelinePeriodRow, 'status' | 'waived'>,
): 'free' | 'regular' | 'benefit' {
  if (row.status === 'pay_regular') return 'regular';
  if (!row.waived) return 'benefit';
  return 'free';
}

// ── #1130 stage 2: the cycle a row belongs to ────────────────────────────────
//
// Stage 1 made the contract's Free -> Pre-paid -> Paid -> Bonus stretch a
// **cycle** and taught both projections to stop after two complete iterations
// of a repeating one. What was left is saying so on screen: a subtle `Cycle`
// column, one thin vertical line per displayed iteration, and a marker under
// the table that says whether it starts again.
//
// None of that is a second answer to anything: the cycle's length and whether
// it repeats are the server's (`timelineCycleFor()`, reported on the
// projection), and the two rules below are pure arithmetic over the period
// numbers the server already assigned. A page that counted its own iterations
// could group rows the nightly run bills differently, which is the drift #635
// stage 12 exists to prevent.

/**
 * The cycle the projection's rows belong to, as the server reports it.
 * `null` for a contract with no Billing & Duration configured at all — there
 * is no cycle to group by, and the table renders exactly as it did before the
 * ticket.
 */
export interface ExampleTimelineCycleInfo {
  /** Periods in one iteration. */
  length: number;
  /** Whether the iteration starts again (the assignment's own Auto Renew). */
  repeats: boolean;
  /** How many iterations the projection shows: 2 while it repeats, 1 otherwise. */
  iterations: number;
}

/** What the Cycle column holds for one row. */
export interface ExampleTimelineRowCycle {
  /**
   * The iteration's number, on its **first** rendered row only (`null` on the
   * rest). It is the iteration this row really is — an Assigned Plan's table
   * starts at the period containing today, so a contract already past its
   * first cycle reads `3` and `4` rather than being relabelled `1` and `2`.
   */
  label: string | null;
  /**
   * The last row of this iteration: its line stops short of the row below, so
   * the next iteration's line does not touch it (the ticket's own rule, and
   * what makes the grouping readable without a horizontal divider).
   */
  endsSegment: boolean;
}

/**
 * The Cycle cell of one row, by its index in the projection.
 *
 * `null` for a row that belongs to no displayed iteration — the trailing
 * regular periods of a contract whose cycle does **not** repeat, which are
 * outside the configured stretch and deliberately carry neither a number nor a
 * line.
 */
export function exampleTimelineRowCycle(
  periods: Pick<ExampleTimelinePeriodRow, 'period'>[],
  cycle: ExampleTimelineCycleInfo | null | undefined,
  index: number,
): ExampleTimelineRowCycle | null {
  const length = Math.trunc(cycle?.length ?? 0);
  const row = periods[index];
  if (!cycle || !(length > 0) || !row) return null;

  // The period numbers are counted from the contract's own anchor (period 1 is
  // the first iteration's first period), so which iteration a row sits in is
  // the one arithmetic question here and needs no state.
  const iterationOf = (period: number) => Math.floor((Math.trunc(period) - 1) / length) + 1;
  const iteration = iterationOf(row.period);
  // A cycle that does not repeat runs once: everything after it is the
  // contract's regular price, not a second iteration.
  if (!cycle.repeats && iteration > 1) return null;

  const next = periods[index + 1];
  return {
    // On the iteration's own first period, and on the first row rendered —
    // which for an Assigned Plan may be in the middle of one.
    label: (Math.trunc(row.period) - 1) % length === 0 || index === 0 ? String(iteration) : null,
    endsSegment: next == null || iterationOf(next.period) !== iteration,
  };
}

/** The same, for every row at once — the shape a test reads and a card maps over. */
export function exampleTimelineRowCycles(
  periods: Pick<ExampleTimelinePeriodRow, 'period'>[],
  cycle: ExampleTimelineCycleInfo | null | undefined,
): (ExampleTimelineRowCycle | null)[] {
  return periods.map((_, index) => exampleTimelineRowCycle(periods, cycle, index));
}

/**
 * Which marker goes under the table: `repeats` for a cycle that starts again,
 * `once` for one that runs through and settles into the regular price, and
 * `null` where there is no cycle to say anything about.
 *
 * It answers the *kind*, never the sentence: the wording (and its `↻` / `✓`
 * glyph) is each card's own locale key, so the table draws a marker it cannot
 * choose.
 */
export function exampleTimelineCycleNote(
  cycle: ExampleTimelineCycleInfo | null,
): 'repeats' | 'once' | null {
  if (!cycle || !(Math.trunc(cycle.length) > 0)) return null;
  return cycle.repeats ? 'repeats' : 'once';
}
