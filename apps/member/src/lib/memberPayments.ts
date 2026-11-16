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
import { DEFAULT_GYM_FORMAT, formatGymAmount, formatGymDateOnly, type GymFormatSettings } from './gymFormat';

export type MemberBillingEventStatus = 'paid' | 'failed' | 'pending' | 'scheduled' | 'recorded' | 'cancelled';

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
  /** #2883 — the cadence those periods are counted in; `null` (or absent) on every other line. */
  prepaid_cadence?: { interval: number; unit: string } | null;
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
  /** #2451 — the method's name as snapshotted when the transaction was created; null when none applies. */
  payment_method_name?: string | null;
  /** #1123 §4 — derived by the API's one implementation, never here. */
  status: MemberBillingEventStatus;
  /** #2936 — the latest stored document of each kind; absent kinds are not listed. */
  documents?: MemberPaymentDocument[];
  /** #2937 — the event's own priced lines (`billing_event_lines`), as stored. */
  lines?: MemberBillingEventLine[];
}

/** #2937 — one priced line of a past Billing Event, exactly as the ledger stored it. */
export interface MemberBillingEventLine {
  id: number;
  kind: 'membership_fee' | 'product' | 'service' | 'adjustment' | string;
  item_name: string;
  quantity: number;
  /** The unit's regular price, when one was recorded (DECIMAL as a string). */
  regular_unit_price: string | null;
  promotion_name: string | null;
  /** What the line charged (DECIMAL as a string). */
  amount: string;
}

/** #2936 — one downloadable document of a payment, as `GET /me/billing-events` reports it. */
export type MemberPaymentDocumentKind = 'receipt' | 'simplified_invoice' | 'full_invoice' | 'refund_receipt';
export interface MemberPaymentDocument {
  kind: MemberPaymentDocumentKind;
  id: number;
  number: string;
}

/** The API path a document is downloaded from; the server re-checks ownership. */
export function paymentDocumentPath(doc: MemberPaymentDocument): string {
  switch (doc.kind) {
    case 'receipt': return `/me/receipts/${doc.id}`;
    case 'refund_receipt': return `/me/refund-receipts/${doc.id}/pdf`;
    default: return `/me/invoices/${doc.id}/pdf`;
  }
}

/** The locale key naming a document kind. */
export function paymentDocumentLabelKey(kind: MemberPaymentDocumentKind): string {
  return `membership.document_${kind}`;
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
 * #2937 — the day a past Billing Event was issued, as the `YYYY-MM-DD` its
 * `created_at` names. Each event is its own row now (it was grouped by this
 * date until #2937), so the header says when *this* event was issued.
 */
export function billingEventIssuedDate(event: MemberBillingEvent): string {
  return event.created_at.slice(0, 10);
}

/** A stored DECIMAL as a number, `null` when it is not one. */
function decimal(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** What a stored line charged, `null` when the stored value is unreadable. */
export function billingEventLineAmount(line: MemberBillingEventLine): number | null {
  return decimal(line.amount);
}

/**
 * The regular price of a stored line (unit × quantity), but only where it
 * differs from what the line charged — the forecast's `showsRegularPrice()`
 * rule for a stored line. Both figures are the ledger's; nothing is re-priced.
 */
export function billingEventLineRegularAmount(line: MemberBillingEventLine): number | null {
  const unit = decimal(line.regular_unit_price);
  const charged = decimal(line.amount);
  if (unit == null || charged == null) return null;
  const regular = round2(unit * (Number(line.quantity) || 0));
  return regular === round2(charged) ? null : regular;
}

/**
 * Whether a past event's row has anything to show when expanded: its lines,
 * its payment method, its documents or its notes. A row with none of them
 * carries no chevron, since opening it would show nothing.
 */
export function billingEventHasDetails(event: MemberBillingEvent): boolean {
  return (event.lines?.length ?? 0) > 0
    || Boolean(event.payment_method_name)
    || (event.documents?.length ?? 0) > 0
    || Boolean(event.notes)
    || (event.event_type === 'status_changed' && Boolean(event.new_status));
}

/**
 * An amount as the gym's number format writes it (#1246), in the currency the server
 * named. The symbol is never spelled here: a deployment that ever quotes
 * anything but euros would otherwise read `€` over a different number.
 *
 * A code that is not three letters falls back to the plain two-decimal figure the rest of this page already shows
 * rather than taking the card down.
 */
export function formatPaymentAmount(
  amount: number | null, currency: string | null | undefined, gym: GymFormatSettings = DEFAULT_GYM_FORMAT,
): string | null {
  if (amount == null || !Number.isFinite(amount)) return null;
  const code = currency || gym.currency;
  if (!/^[A-Za-z]{3}$/.test(code)) return amount.toFixed(2);
  return formatGymAmount(amount, { ...gym, currency: code.toUpperCase() });
}

/**
 * A billing date in the gym's date format (#1246). The stored value is
 * a `YYYY-MM-DD` string for a forecast group and a timestamp for a ledger row;
 * both are read as UTC, because the date a charge falls on is the one the
 * nightly run compares in SQL and must not shift by a timezone.
 */
export function formatPaymentDate(value: string, gym: GymFormatSettings = DEFAULT_GYM_FORMAT): string {
  const date = formatGymDateOnly(value.slice(0, 10), gym);
  return date === '—' ? value.slice(0, 10) : date;
}

/**
 * Which locale key names what a forecast line *is* — `Membership Plan` or
 * `Product`, §2's first line of each item. The name beside it is the server's
 * (`label`: the Plan's own name, or the Product's), so this is the only part of
 * an item's heading the Members App words itself.
 */
export function lineKindKey(line: { kind: string }): string {
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

/**
 * #2883 — the `payments.*` key that says how many billing periods a Membership Fee charge collected
 * up front covers, in the plan's own cadence (`2 months pre-payment`, `2 × 4 weeks pre-payment`), or
 * `null` when the charge is not a pre-payment. The admin's `prepaidPaymentKey()` says the same
 * thing; the two apps share no frontend module. The page resolves it with `{ count }`.
 */
export function prepaidPaymentKey(
  count: number | null | undefined,
  cadence: { interval: unknown; unit: unknown } | null | undefined,
): string | null {
  if (count == null || !Number.isInteger(count) || count <= 0) return null;
  const n = Number(cadence?.interval);
  const unit = cadence?.unit;
  if (n === 1 && unit === 'month') return 'prepaid_payment_month';
  if (n === 4 && unit === 'week') return 'prepaid_payment_four_weeks';
  if (n === 1 && unit === 'week') return 'prepaid_payment_week';
  if (n === 1 && unit === 'year') return 'prepaid_payment_year';
  return 'prepaid_payment_periods';
}
