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
//  - the forecast of the member's Active Product Set (`productSetForecast()`, the
//    engine's own projection, two complete cycles from today), each date one
//    `forecast` point — **unless a persisted event already stands on that date
//    for a schedule**, because the obligations of the next cycles are persisted
//    (`materialiseScheduledEvents()`) and a forecast point beside them would
//    report one charge twice.
//
// Nothing is stored and nothing is written: a forecast point is never a Billing
// Event, and a past payment keeps its own date whatever the configuration
// becomes, since it is read from the ledger rather than from the engine.

import { ledgerEventStatus, scheduledExecutionDate } from './memberPaymentView';

export type TimelinePointKind = 'payment' | 'scheduled' | 'forecast';

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
  /** The ledger status for a persisted event; `null` for a forecast. */
  status: string | null;
  /** The persisted event this point is; `null` for a forecast. */
  billing_event_id: number | null;
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
  /** Whether the event belongs to a billing schedule (`schedule_id` set). */
  on_schedule: boolean;
  cancelled: boolean;
  latest_tx_status: string | null;
  /** When the latest completed payment attempt completed; `null` when none did. */
  paid_at: Date | string | null;
  lines: TimelineLine[];
}

export interface TimelineForecastDate {
  date: string;
  total: number;
  name?: string | null;
  lines: { label: string; quantity: number; actual_charge: number }[];
}

export interface PaymentsTimeline {
  today: string;
  points: TimelinePoint[];
}

function day(value: Date | string): string {
  return scheduledExecutionDate(value, value);
}

/** Events the member's ledger never shows as a payment: a card check, a retired status row. */
function isPlotted(eventType: string): boolean {
  return eventType !== 'card_verification' && eventType !== 'status_changed';
}

export function buildPaymentsTimeline(input: {
  today: string;
  events: TimelineEventInput[];
  forecast: TimelineForecastDate[];
}): PaymentsTimeline {
  const today = input.today.slice(0, 10);
  const points: TimelinePoint[] = [];
  const persistedScheduleDates = new Set<string>();

  for (const e of input.events) {
    if (!isPlotted(e.event_type)) continue;
    const scheduled = e.is_scheduled && !e.cancelled;
    const billingDay = scheduledExecutionDate(e.billing_date, e.created_at);
    if (!e.cancelled && (e.is_scheduled || e.on_schedule) && e.billing_date != null) {
      persistedScheduleDates.add(scheduledExecutionDate(e.billing_date, e.created_at));
    }
    points.push({
      kind: scheduled ? 'scheduled' : 'payment',
      date: !scheduled && e.paid_at != null ? day(e.paid_at) : billingDay,
      amount: e.amount,
      status: ledgerEventStatus(e.event_type, e.latest_tx_status, e.cancelled, scheduled),
      billing_event_id: e.id,
      name: e.name,
      event_type: e.event_type,
      lines: e.lines,
    });
  }

  for (const f of input.forecast) {
    const date = f.date.slice(0, 10);
    if (date < today || persistedScheduleDates.has(date)) continue;
    points.push({
      kind: 'forecast',
      date,
      amount: f.total,
      status: null,
      billing_event_id: null,
      name: f.name ?? null,
      event_type: null,
      lines: f.lines.map((l) => ({ label: l.label, quantity: l.quantity, amount: l.actual_charge })),
    });
  }

  const order: Record<TimelinePointKind, number> = { payment: 0, scheduled: 1, forecast: 2 };
  points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
    : order[a.kind] - order[b.kind] || (a.billing_event_id ?? 0) - (b.billing_event_id ?? 0)));
  return { today, points };
}
