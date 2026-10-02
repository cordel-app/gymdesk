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
