// #3311 — which point a ledger row or a forecast date becomes on the Member
// card's Payments History and Forecast.

import { describe, expect, it } from 'vitest';
import { buildPaymentsTimeline, type TimelineEventInput } from '../domain/paymentsTimeline';

const TODAY = '2026-06-15';

function event(over: Partial<TimelineEventInput>): TimelineEventInput {
  return {
    id: 1, event_type: 'payment_recorded', amount: 50, name: null,
    billing_date: null, created_at: '2026-01-10T08:00:00Z', is_scheduled: false, on_schedule: false,
    cancelled: false, latest_tx_status: null, paid_at: null, lines: [],
    ...over,
  };
}

const forecastDate = (date: string, total = 70) => ({
  date, total, lines: [{ label: 'Membership Fee', quantity: 1, actual_charge: total }],
});

describe('buildPaymentsTimeline', () => {
  it('positions a paid event at the day its payment completed, not its billing date', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [event({ billing_date: '2026-03-01', latest_tx_status: 'completed', paid_at: '2026-03-04T10:00:00Z' })],
      forecast: [],
    });
    expect(t.points).toEqual([expect.objectContaining({ kind: 'payment', date: '2026-03-04', status: 'paid', billing_event_id: 1 })]);
  });

  it('positions an unpaid event at its execution date and keeps its status', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [event({ billing_date: '2026-04-01', latest_tx_status: 'failed' })],
      forecast: [],
    });
    expect(t.points[0]).toMatchObject({ kind: 'payment', date: '2026-04-01', status: 'failed' });
  });

  it('reads a persisted, unexecuted obligation as scheduled and drops the forecast on its date', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [event({ id: 7, billing_date: '2026-07-01', is_scheduled: true, on_schedule: true })],
      forecast: [forecastDate('2026-07-01'), forecastDate('2026-08-01'), forecastDate('2026-09-01')],
    });
    expect(t.points.map((p) => [p.kind, p.date])).toEqual([
      ['scheduled', '2026-07-01'], ['forecast', '2026-08-01'], ['forecast', '2026-09-01'],
    ]);
    expect(t.points[0]).toMatchObject({ billing_event_id: 7, status: 'scheduled' });
    expect(t.points[1]).toMatchObject({ billing_event_id: null, status: null, amount: 70 });
  });

  it('drops a forecast date already executed today by its schedule', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [event({ billing_date: TODAY, on_schedule: true, latest_tx_status: 'completed', paid_at: `${TODAY}T03:00:00Z` })],
      forecast: [forecastDate(TODAY), forecastDate('2026-07-15')],
    });
    expect(t.points.map((p) => p.kind)).toEqual(['payment', 'forecast']);
  });

  it('a cancelled scheduled event is history, and the forecast stands on its date', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [event({ billing_date: '2026-07-01', is_scheduled: true, on_schedule: true, cancelled: true })],
      forecast: [forecastDate('2026-07-01')],
    });
    expect(t.points.map((p) => [p.kind, p.status])).toEqual([['payment', 'cancelled'], ['forecast', null]]);
  });

  it('a one-off purchase is exactly one point, with no forecast of its own', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [event({ event_type: 'product_purchase', latest_tx_status: 'completed', paid_at: '2026-05-02T09:00:00Z' })],
      forecast: [],
    });
    expect(t.points).toHaveLength(1);
    expect(t.points[0]).toMatchObject({ kind: 'payment', event_type: 'product_purchase', date: '2026-05-02' });
  });

  it('leaves card verifications off and never plots a forecast before today', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [event({ event_type: 'card_verification', amount: 0 })],
      forecast: [forecastDate('2026-06-01')],
    });
    expect(t.points).toEqual([]);
  });

  it('orders points by date, then payment, scheduled, forecast', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [
        event({ id: 2, billing_date: '2026-08-01', is_scheduled: true }),
        event({ id: 1, billing_date: '2026-02-01', latest_tx_status: 'completed', paid_at: '2026-02-01' }),
      ],
      forecast: [forecastDate('2026-07-01')],
    });
    expect(t.points.map((p) => p.date)).toEqual(['2026-02-01', '2026-07-01', '2026-08-01']);
  });
});
