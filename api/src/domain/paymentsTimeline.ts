// #3311 — the Member card's **Payments History and Forecast**: one timeline of
// what was paid, what is scheduled and what the engine forecasts, decided here.
//
// It reads two authoritative sources and invents nothing:
//
//  - the member's persisted Billing Events (the ledger the Payments tab lists),
//    each one point: a persisted obligation not yet executed
//    (`is_scheduled = 1`, not cancelled) is `scheduled` at its billing date, and
//    every other event is a `payment` at the day its payment completed, else the
//    day it is (or was) executed on (`scheduledExecutionDate()`, #3297's rule);
//  - the forecast of the member's Active Product Set: the engine's obligations
//    (`planScheduledEvents()`), one per schedule and billing date, over one
//    common horizon of two complete cycles of the longest recurring cadence
//    (#3446). Each obligation is one `forecast` point (positive amount) or one
//    `no_charge` point (zero) — **unless that very obligation is already
//    persisted**: a Billing Event of the same schedule for the same period, or
//    (for a recurring Product line, `materialiseScheduledEvents()`' paid-up
//    rule) a payment on that date carrying every one of its Products. The match
//    is the obligation's, never the date's, so another schedule's event on the
//    same day hides nothing (#3446 §8). A one-off obligation (no schedule) is
//    never forecast: it is the ledger's own payment point.
//
// Since #3435 a cancelled attempt that collected nothing is not plotted, and a
// failed or pending payment carries `alert` (`domain/memberPaymentsVisibility.ts`).
// Since #3311 stage 3 an event whose latest attempt expired and that collected
// nothing is not plotted either (`isExpiredUncollected()`); the obligation it
// is still counts as persisted, so its period is not forecast again.
//
// Nothing is stored and nothing is written: a forecast point is never a Billing
// Event, and a past payment keeps its own date whatever the configuration
// becomes, since it is read from the ledger rather than from the engine.

import { ledgerEventStatus, scheduledExecutionDate } from './memberPaymentView';
import { isHiddenFromMemberPayments, paymentAlert, type PaymentAlert } from './memberPaymentsVisibility';

export type TimelinePointKind = 'payment' | 'scheduled' | 'forecast' | 'no_charge';

/** #3446 — what a point that is not a persisted event reports as its status. */
export const FORECASTED_STATUS = 'forecasted';
export const NO_CHARGE_STATUS = 'no_charge';

export interface TimelineLine {
  label: string;
  quantity: number;
  amount: number;
}

export interface TimelinePoint {
  kind: TimelinePointKind;
  /** `YYYY-MM-DD` — where the point sits on the axis. */
  date: string;
  amount: number;
  /** The ledger status for a persisted event; `forecasted` / `no_charge` for a projection. */
  status: string | null;
  /** The persisted event this point is; `null` for a forecast. */
  billing_event_id: number | null;
  /** #3435: a failed or pending payment, marked on the chart; `null` otherwise. */
  alert: PaymentAlert | null;
  name: string | null;
  event_type: string | null;
  lines: TimelineLine[];
}

export interface TimelineEventInput {
  id: number;
  event_type: string;
  amount: number;
  name: string | null;
  billing_date: Date | string | null;
  created_at: Date | string;
  is_scheduled: boolean;
  /** The key of the billing schedule the event belongs to; `null` when it has none. */
  schedule_key: string | null;
  /** The schedule period the event covers (`period_start`); `null` when it has none. */
  period_start: Date | string | null;
  /** The Products its lines carry (`materialiseScheduledEvents()`' paid-up rule). */
  product_ids?: number[];
  cancelled: boolean;
  latest_tx_status: string | null;
  /** When the latest completed payment attempt completed; `null` when none did. */
  paid_at: Date | string | null;
  lines: TimelineLine[];
}

/** One projected obligation: one schedule's lines on one billing date (`planScheduledEvents()`). */
export interface TimelineForecastObligation {
  schedule_key: string | null;
  date: string;
  total: number;
  name?: string | null;
  lines: { label: string; quantity: number; actual_charge: number; kind?: string; product_id?: number | null }[];
}

export interface PaymentsTimeline {
  today: string;
  points: TimelinePoint[];
}

function day(value: Date | string): string {
  return scheduledExecutionDate(value, value);
}

function obligationKey(scheduleKey: string, date: string): string {
  return `${scheduleKey}|${date}`;
}

/**
 * #3446 — the common horizon of the chart: the last date of the engine's own
 * per-stream projection (two complete cycles of each recurring schedule from
 * today), i.e. two cycles of the longest cadence. `null` when nothing recurs.
 */
export function commonForecastHorizon(obligations: { schedule_key: string | null; date: string }[]): string | null {
  let latest: string | null = null;
  for (const o of obligations) {
    if (o.schedule_key == null) continue;
    const d = o.date.slice(0, 10);
    if (latest == null || d > latest) latest = d;
  }
  return latest;
}

/** #3311 stage 3 — an event whose latest attempt expired and that collected nothing: not a point. */
export function isExpiredUncollected(e: { latest_tx_status: string | null; paid_at: Date | string | null }): boolean {
  return e.latest_tx_status === 'expired' && e.paid_at == null;
}

/** Events the member's ledger never shows as a payment: a card check, a retired status row. */
function isPlotted(eventType: string): boolean {
  return eventType !== 'card_verification' && eventType !== 'status_changed';
}

export function buildPaymentsTimeline(input: {
  today: string;
  events: TimelineEventInput[];
  forecast: TimelineForecastObligation[];
}): PaymentsTimeline {
  const today = input.today.slice(0, 10);
  const points: TimelinePoint[] = [];
  const persistedObligations = new Set<string>();
  const productsPaidOn = new Map<string, Set<number>>();

  for (const e of input.events) {
    if (!isPlotted(e.event_type)) continue;
    // #3435: a cancelled attempt that collected nothing is not a payment.
    if (isHiddenFromMemberPayments({ cancelled: e.cancelled, latestTxStatus: e.latest_tx_status, collected: e.paid_at != null })) continue;
    const scheduled = e.is_scheduled && !e.cancelled;
    const billingDay = scheduledExecutionDate(e.billing_date, e.created_at);
    if (!e.cancelled && e.schedule_key != null) {
      persistedObligations.add(obligationKey(e.schedule_key, day(e.period_start ?? e.billing_date ?? e.created_at)));
    }
    // #3311 stage 3: an expired attempt that collected nothing is not a point.
    if (isExpiredUncollected(e)) continue;
    if (!e.cancelled && !e.is_scheduled && e.billing_date != null) {
      const set = productsPaidOn.get(billingDay) ?? new Set<number>();
      for (const id of e.product_ids ?? []) set.add(id);
      productsPaidOn.set(billingDay, set);
    }
    const status = ledgerEventStatus(e.event_type, e.latest_tx_status, e.cancelled, scheduled);
    points.push({
      kind: scheduled ? 'scheduled' : 'payment',
      date: !scheduled && e.paid_at != null ? day(e.paid_at) : billingDay,
      amount: e.amount,
      status,
      billing_event_id: e.id,
      alert: scheduled ? null : paymentAlert(status),
      name: e.name,
      event_type: e.event_type,
      lines: e.lines,
    });
  }

  for (const f of input.forecast) {
    const date = f.date.slice(0, 10);
    // A one-off has no recurring series: the ledger's payment is its point.
    if (f.schedule_key == null || date < today) continue;
    if (persistedObligations.has(obligationKey(f.schedule_key, date))) continue;
    // A recurring Product line paid up front by a payment on this date is not owed again.
    const productIds = f.lines.map((l) => l.product_id).filter((id): id is number => id != null);
    const paid = productsPaidOn.get(date);
    if (!f.lines.some((l) => l.kind === 'membership_fee') && productIds.length > 0 && paid
      && productIds.every((id) => paid.has(id))) continue;
    const charged = f.total > 0;
    points.push({
      kind: charged ? 'forecast' : 'no_charge',
      date,
      amount: f.total,
      status: charged ? FORECASTED_STATUS : NO_CHARGE_STATUS,
      billing_event_id: null,
      alert: null,
      name: f.name ?? null,
      event_type: null,
      lines: f.lines.map((l) => ({ label: l.label, quantity: l.quantity, amount: l.actual_charge })),
    });
  }

  const order: Record<TimelinePointKind, number> = { payment: 0, scheduled: 1, forecast: 2, no_charge: 3 };
  points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
    : order[a.kind] - order[b.kind] || (a.billing_event_id ?? 0) - (b.billing_event_id ?? 0)));
  return { today, points };
}
