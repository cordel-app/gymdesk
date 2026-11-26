// #1123 — everything the Members App's **Payments** tab decides or formats,
// and nothing it draws. Since #3297 the tab is organised around each payment's
// **scheduled execution date** (`paymentSections()`): *Next Payment*,
// *Planned Payments* and *Past Payments*, all three read from the member's own
// ledger (`GET /me/billing-events`) — the real Billing Events, persisted
// obligations included — and never from the forecast, which is a projection
// and not a payment. `components/MemberPaymentsCard.tsx` is the look. Nothing
// in this module calls `t()`: every label arrives already resolved, so both
// halves stay assertable (`api/src/test/member-payments.unit.test.ts`, in the
// API suite because CI runs `npm test` in `api/` only).
//
// Four of its answers are the rule rather than the implementation.
//
//  - **Nothing here computes money.** Every amount, every date, every status
//    and the full/partial payment and refund types are the server's. This
//    module reorders, groups and formats; it never adds.
//  - **The section is the scheduled date's, never the status's.** A payment
//    executed on a day after today is *Planned*, one on a day before it is
//    *Past*; a payment scheduled for today is *Planned* while it still awaits
//    execution (`scheduled`) and *Past* once it has run.
//  - **Next Payment is a summary, not a bucket**: the nearest planned payment
//    plus every payment still needing attention (failed, pending), each once.
//    The nearest planned payment is listed under *Planned Payments* too.
//  - **A payment's status is its own, never the section's.** One date can carry
//    a settled charge and a rejected one.

/** `payment_requests.status` folded onto the event, as `#640` derives it. */
import { DEFAULT_GYM_FORMAT, formatGymAmount, formatGymDateOnly, type GymFormatSettings } from './gymFormat';

/** #3332: no `recorded` fallback; `null` = the event records no payment. */
export type MemberBillingEventStatus = 'paid' | 'failed' | 'pending' | 'scheduled' | 'waived' | 'cancelled';

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
  /** #3235 — the assignment whose forecast the line came from (the API's own tag). */
  user_membership_id?: number;
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
  /** #2940 — the event's generated name, the same text the Admin shows; null for an event written before it. */
  name?: string | null;
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
  status: MemberBillingEventStatus | null;
  /** #3297 — the day the payment is (or was) executed on (`YYYY-MM-DD`, UTC); the API's. */
  scheduled_date?: string | null;
  /** #3297 — whether the money collected covered the amount; null when nothing was collected. */
  payment_type?: 'full' | 'partial' | null;
  /** #3297 — whether a refund returned all or part of it; null when nothing was refunded. */
  refund_type?: 'full' | 'partial' | null;
  /** #2936 — the latest stored document of each kind; absent kinds are not listed. */
  documents?: MemberPaymentDocument[];
  /** #2937 — the event's own priced lines (`billing_event_lines`), as stored. */
  lines?: MemberBillingEventLine[];
}

/** #2937 — one priced line of a past Billing Event, exactly as the ledger stored it. */
export interface MemberBillingEventLine {
  id: number;
  kind: 'membership_fee' | 'product' | 'service' | 'adjustment' | string;
  /** #3254 — the line's origin, `plan` | `product` (null when neither applies). */
  source?: 'plan' | 'product' | null;
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
  /** #3242 — when the document was issued (ISO 8601, UTC); null when not recorded. */
  issued_at?: string | null;
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

/** A document's identity, as the download state and the React list key read it. */
export function paymentDocumentKey(doc: MemberPaymentDocument): string {
  return `${doc.kind}:${doc.id}`;
}

/** #3242 — the file name a downloaded document is saved under, from its kind and number. */
export function paymentDocumentFileName(doc: MemberPaymentDocument): string {
  const number = String(doc.number ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${doc.kind.replace(/_/g, '-')}${number ? `-${number}` : `-${doc.id}`}.pdf`;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export const EMPTY_FORECAST: BillingEventForecast = {
  available: false, reason: null, currency: 'EUR', anchor_date: null, horizon_date: null,
  tax_included: true, truncated: false, dates: [], total: 0,
};

/** #3297 — the day a payment is (or was) executed on: the API's `scheduled_date`, else the day it was written. */
export function paymentScheduledDate(event: MemberBillingEvent): string {
  return (event.scheduled_date || event.created_at).slice(0, 10);
}

/** #3297 — a payment still needing the member's attention, whatever its date. */
export function isUnresolvedPayment(event: MemberBillingEvent): boolean {
  return event.status === 'failed' || event.status === 'pending';
}

/** #3297 — whether a payment belongs under *Planned Payments* on `today` (`YYYY-MM-DD`, UTC). */
export function isPlannedPayment(event: MemberBillingEvent, today: string): boolean {
  const date = paymentScheduledDate(event);
  if (date > today) return true;
  // Due today: planned until it has been executed.
  return date === today && event.status === 'scheduled';
}

export interface PaymentSections {
  /** The nearest planned payment first, then every unresolved payment, each once. */
  next: MemberBillingEvent[];
  /** Every planned payment, nearest first (the next one included). */
  planned: MemberBillingEvent[];
  /** Every payment whose execution date has passed, newest first. */
  past: MemberBillingEvent[];
}

/**
 * #3297 — the three sections of the Payments tab, from the member's ledger.
 * `today` is the UTC date the API's scheduled dates are written in.
 */
export function paymentSections(events: MemberBillingEvent[], today: string): PaymentSections {
  const byDate = (a: MemberBillingEvent, b: MemberBillingEvent) =>
    paymentScheduledDate(a).localeCompare(paymentScheduledDate(b)) || a.id - b.id;
  const planned = events.filter((e) => isPlannedPayment(e, today)).sort(byDate);
  const past = events.filter((e) => !isPlannedPayment(e, today)).sort((a, b) => byDate(b, a));
  const next: MemberBillingEvent[] = [];
  const seen = new Set<number>();
  const add = (e: MemberBillingEvent) => { if (!seen.has(e.id)) { seen.add(e.id); next.push(e); } };
  // The nearest planned payment that is still owed (a cancelled one is no payment to come).
  const nearest = planned.find((e) => e.status !== 'cancelled');
  if (nearest) add(nearest);
  [...planned, ...past].filter(isUnresolvedPayment).sort(byDate).forEach(add);
  return { next, planned, past };
}

/** #3297 — the locale key of a payment's payment-type chip (*Full payment* / *Partial payment*), or `null`. */
export function paymentTypeKey(event: MemberBillingEvent): string | null {
  return event.payment_type ? `payment_type_${event.payment_type}` : null;
}

/** #3297 — the locale key of a payment's refund chip (*Full refund* / *Partial refund*), or `null`. */
export function refundTypeKey(event: MemberBillingEvent): string | null {
  return event.refund_type ? `refund_type_${event.refund_type}` : null;
}

/** #3297 — the UTC date a scheduled date is compared with. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * #3235 — the next scheduled payment a plan is part of: the first forecast date
 * carrying a line of its assignment. Its `total` is that payment's amount — the
 * whole Billing Event charged on that date, never one line's price. `null` when
 * the plan has no assignment yet or nothing further is scheduled for it.
 * A date whose payment charges nothing is skipped (#3463).
 */
export function planNextPayment(
  forecast: BillingEventForecast | null, userMembershipId: number | null | undefined,
): ForecastDate | null {
  if (!forecast?.available || userMembershipId == null) return null;
  return forecast.dates.find((d) => isPayableDate(d)
    && d.lines.some((l) => l.user_membership_id === userMembershipId)) ?? null;
}

/**
 * #3235 — the next scheduled payment a recurring Product line is part of: the
 * first forecast date carrying a Product line of that Product. `null` when none.
 * A date whose payment charges nothing is skipped (#3463).
 */
export function productNextPayment(
  forecast: BillingEventForecast | null, productId: number | null | undefined,
): ForecastDate | null {
  if (!forecast?.available || productId == null) return null;
  return forecast.dates.find((d) => isPayableDate(d)
    && d.lines.some((l) => l.kind === 'product' && l.product_id === productId)) ?? null;
}

/**
 * #3463 — a payment that charges nothing is not a *Next payment*: a free or
 * fully discounted cycle is skipped and the next date that charges something
 * is shown instead, its date and amount from that same Billing Event. The
 * amount is the server's `total`; nothing here prices it.
 */
function isPayableDate(date: ForecastDate): boolean {
  return Number(date.total) > 0;
}

/**
 * The DOM id of the payment on the Payments tab that falls on `date`, so a plan
 * or Product card's *View payment* (#3235) can reach it.
 */
export function forecastPaymentAnchorId(date: string): string {
  return `payment-${date}`;
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
 * Whether a payment's row has anything to show when expanded: its lines, its
 * documents (#3297: inside the payment they belong to), its payment method or
 * its notes. A row with none of them carries no chevron.
 */
export function billingEventHasDetails(event: MemberBillingEvent): boolean {
  return (event.lines?.length ?? 0) > 0
    || (event.documents?.length ?? 0) > 0
    || Boolean(event.payment_method_name)
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
