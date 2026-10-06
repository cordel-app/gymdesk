// #1123 — everything the Members App's **Payments** card decides or formats,
// and nothing it draws.
//
// The card has three subcards (§1): *Next Payment*, *Past Billing Events* and
// *Forecast Billing Events*. Two of them read the same projection and the third
// reads the ledger, so the decisions that say which rows belong to which
// subcard, and how a figure is written, live here — `components/MemberPaymentsCard.tsx`
// is the look, exactly as `NutritionItemRow` (#932) and `GoalReadings` (#1037)
// split. Nothing in this module calls `t()`: every label arrives already
// resolved, so both halves stay assertable (`api/src/test/member-payments.unit.test.ts`,
// in the API suite because CI runs `npm test` in `api/` only).
//
// Four of its answers are the rule rather than the implementation.
//
//  - **Nothing here computes money.** Every amount, every date and every
//    treatment is the server's (`GET /me/billing-event-forecast`, the Assigned
//    Plan card's own projection scoped to the caller), because
//    `resolveMembershipFee()` is the one implementation of what a cycle costs
//    and a second arithmetic in a page is what #635 stage 12 existed to remove.
//    This module reorders, groups and formats; it never adds.
//  - **Next Payment is the forecast's first group**, and the Forecast subcard is
//    the rest of it (`forecastDatesAfterNext`). One projection answers both, so
//    the two cannot disagree, and the next payment is not shown twice.
//  - **A past event's status is the line's, never the card's.** The ledger is
//    one row per Billing Event, each with its own derived status (#640), and a
//    single date can carry a settled charge and a rejected one — a card-level
//    status would have to pick one and would call a failed payment paid.
//  - **A forecast card carries no status at all.** Nothing has been charged yet,
//    so §5's "visually distinguishable from completed/paid events" is the
//    absence of the pill the past cards carry plus the page's own badge, rather
//    than a colour invented for a projection.

/** `payment_requests.status` folded onto the event, as `#640` derives it. */
export type MemberBillingEventStatus = 'paid' | 'failed' | 'pending' | 'scheduled' | 'recorded';

/** Why a forecast line's charge differs from its regular price. */
export interface ForecastBenefit {
  source: 'promotion' | 'membership_plan' | 'personal';
  name: string | null;
  action: 'no_benefit' | 'waive' | 'percentage_discount' | 'fixed_discount' | 'fixed_price' | 'included';
  value: number | null;
  period_status: string | null;
}

/** One item of one forecast billing event. Every money field is the engine's. */
export interface ForecastLine {
  kind: 'membership_fee' | 'product';
  label: string;
  product_id: number | null;
  mandatory: boolean;
  quantity: number;
  unit_price: number;
  regular_price: number;
  actual_charge: number;
  /** #946 — the Pre-paid periods this one charge covers; `null` on every other line. */
  prepaid_periods: number | null;
  benefits: ForecastBenefit[];
}

/** Every line that falls on one future billing date, and what that date costs. */
export interface ForecastDate {
  date: string;
  lines: ForecastLine[];
  total: number;
}

/** The wire shape of `GET /me/billing-event-forecast`. */
export interface BillingEventForecast {
  available: boolean;
  reason: string | null;
  currency: string;
  anchor_date: string | null;
  horizon_date: string | null;
  tax_included: boolean;
  truncated: boolean;
  dates: ForecastDate[];
  total: number;
}

/** One row of `GET /me/billing-events` — the member's own ledger. */
export interface MemberBillingEvent {
  id: number;
  event_type: string;
  charge_type_code: string | null;
  previous_status: string | null;
  new_status: string | null;
  amount: string | null;
  notes: string | null;
  created_at: string;
  receipt_number: string | null;
  /** #1123 §4 — derived by the API's one implementation, never here. */
  status: MemberBillingEventStatus;
}

/** Past Billing Events, grouped the way the forecast groups its own: by date. */
export interface PastBillingEventGroup {
  date: string;
  events: MemberBillingEvent[];
  /** The sum of the events that carry an amount — a `status_changed` row carries none. */
  total: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export const EMPTY_FORECAST: BillingEventForecast = {
  available: false, reason: null, currency: 'EUR', anchor_date: null, horizon_date: null,
  tax_included: true, truncated: false, dates: [], total: 0,
};

/**
 * The next billing event in time — the forecast's first group, which is what the
 * thread asked *Next Payment* to be. `null` when there is no projection at all
 * (no plan, or one that bills nothing further), which is what makes the subcard
 * render its empty state rather than an empty card.
 */
export function nextPaymentDate(forecast: BillingEventForecast | null): ForecastDate | null {
  if (!forecast?.available) return null;
  return forecast.dates[0] ?? null;
}

/**
 * The groups the *Forecast* subcard lists: everything after the next payment.
 *
 * The next one is deliberately excluded — it is the card above, in full, and a
 * member reading the same €150 twice would reasonably count it twice.
 */
export function forecastDatesAfterNext(forecast: BillingEventForecast | null): ForecastDate[] {
  if (!forecast?.available) return [];
  return forecast.dates.slice(1);
}

/** The numeric amount of a ledger row, or `null` for a row that records no money. */
export function billingEventAmount(event: MemberBillingEvent): number | null {
  if (event.amount == null) return null;
  const n = Number(event.amount);
  return Number.isFinite(n) ? n : null;
}

/**
 * The ledger as one card per date, newest first — §4's structure, and the same
 * grouping the forecast beside it uses, which is the whole point of the section
 * reading "the same Billing Event card structure".
 *
 * The rows arrive newest first (`ORDER BY be.created_at DESC`) and the grouping
 * preserves that order rather than re-sorting: the server decides what "most
 * recent" means, including the `id DESC` tie-break for two events written in the
 * same second.
 */
export function pastBillingEventGroups(events: MemberBillingEvent[]): PastBillingEventGroup[] {
  const groups: PastBillingEventGroup[] = [];
  const byDate = new Map<string, PastBillingEventGroup>();
  for (const event of events) {
    const date = event.created_at.slice(0, 10);
    let group = byDate.get(date);
    if (!group) {
      group = { date, events: [], total: 0 };
      byDate.set(date, group);
      groups.push(group);
    }
    group.events.push(event);
    group.total = round2(group.total + (billingEventAmount(event) ?? 0));
  }
  return groups;
}

/**
 * An amount as the member's own locale writes it, in the currency the server
 * named. The symbol is never spelled here: a deployment that ever quotes
 * anything but euros would otherwise read `€` over a different number.
 *
 * `Intl` throws on a currency code it does not know, so an unusable one falls
 * back to the plain two-decimal figure the rest of this page already shows
 * rather than taking the card down.
 */
export function formatPaymentAmount(
  amount: number | null, currency: string | null | undefined, locale: string,
): string | null {
  if (amount == null || !Number.isFinite(amount)) return null;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency: currency || 'EUR',
    }).format(amount);
  } catch {
    return amount.toFixed(2);
  }
}

/**
 * A billing date as the member reads it (`15 October 2026`). The stored value is
 * a `YYYY-MM-DD` string for a forecast group and a timestamp for a ledger row;
 * both are read as UTC, because the date a charge falls on is the one the
 * nightly run compares in SQL and must not shift by a timezone.
 */
export function formatPaymentDate(value: string, locale: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(date);
}

/**
 * Which locale key names what a forecast line *is* — `Membership Plan` or
 * `Product`, §2's first line of each item. The name beside it is the server's
 * (`label`: the Plan's own name, or the Product's), so this is the only part of
 * an item's heading the Members App words itself.
 */
export function lineKindKey(line: ForecastLine): string {
  return line.kind === 'membership_fee' ? 'line_kind_membership_fee' : 'line_kind_product';
}

/**
 * Which locale key describes why a line is not at its regular price, and `null`
 * when it is — §3's "Promotion/discount, where applicable".
 *
 * It reads the treatment the server reported and never compares amounts, for
 * `simulationLineTone()`'s reason one app over: €0.00 is also what an item with
 * no price costs. The first benefit decides, which is the order the engine
 * applies them in.
 */
export function lineTreatmentKey(line: ForecastLine): string | null {
  const benefit = line.benefits.find((b) => b.action !== 'no_benefit');
  switch (benefit?.action) {
    case 'waive':
    case 'included': return 'treatment_waived';
    case 'percentage_discount': return 'treatment_percentage';
    case 'fixed_discount': return 'treatment_fixed_discount';
    case 'fixed_price': return 'treatment_fixed_price';
    default: return null;
  }
}

/**
 * The name of whatever is discounting a line — a Promotion's own name — or
 * `null` when the discount has no name to give (a Plan benefit, the Personal
 * Membership Fee Benefit). The page appends it to the treatment caption only
 * when there is one, so a nameless benefit never renders a dangling separator.
 */
export function lineTreatmentName(line: ForecastLine): string | null {
  const benefit = line.benefits.find((b) => b.action !== 'no_benefit');
  return benefit?.name?.trim() ? benefit.name.trim() : null;
}

/**
 * Whether a line's regular price is worth showing beside its final one: only
 * when the two differ. Showing `€50.00 → €50.00` on every ordinary cycle is
 * noise, and on a phone it is noise that costs a line of the breakdown.
 */
export function showsRegularPrice(line: ForecastLine): boolean {
  return round2(line.regular_price) !== round2(line.actual_charge);
}
