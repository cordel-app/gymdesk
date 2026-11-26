// #3311 — which point a ledger row or a forecast date becomes on the Member
// card's Payments History and Forecast.

import { describe, expect, it } from 'vitest';
import { buildPaymentsTimeline, commonForecastHorizon, type TimelineEventInput } from '../domain/paymentsTimeline';

const TODAY = '2026-06-15';

function event(over: Partial<TimelineEventInput>): TimelineEventInput {
  return {
    id: 1, event_type: 'payment_recorded', amount: 50, name: null,
    billing_date: null, created_at: '2026-01-10T08:00:00Z', is_scheduled: false, schedule_key: null, period_start: null,
    cancelled: false, latest_tx_status: null, paid_at: null, lines: [],
    ...over,
  };
}

const forecastDate = (date: string, total = 70, schedule_key: string | null = 'plan') => ({
  schedule_key, date, total, lines: [{ label: 'Membership Fee', quantity: 1, actual_charge: total, kind: 'membership_fee' }],
});
const productForecast = (date: string, schedule_key: string, product_id: number, total: number) => ({
  schedule_key, date, total,
  lines: [{ label: `Product ${product_id}`, quantity: 1, actual_charge: total, kind: 'product', product_id }],
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
      events: [event({ id: 7, billing_date: '2026-07-01', is_scheduled: true, schedule_key: 'plan' })],
      forecast: [forecastDate('2026-07-01'), forecastDate('2026-08-01'), forecastDate('2026-09-01')],
    });
    expect(t.points.map((p) => [p.kind, p.date])).toEqual([
      ['scheduled', '2026-07-01'], ['forecast', '2026-08-01'], ['forecast', '2026-09-01'],
    ]);
    expect(t.points[0]).toMatchObject({ billing_event_id: 7, status: 'scheduled' });
    expect(t.points[1]).toMatchObject({ billing_event_id: null, status: 'forecasted', amount: 70 });
  });

  it('drops a forecast date already executed today by its schedule', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [event({ billing_date: TODAY, schedule_key: 'plan', latest_tx_status: 'completed', paid_at: `${TODAY}T03:00:00Z` })],
      forecast: [forecastDate(TODAY), forecastDate('2026-07-15')],
    });
    expect(t.points.map((p) => p.kind)).toEqual(['payment', 'forecast']);
  });

  it('#3435: a cancelled scheduled event is not plotted, and the forecast stands on its date', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [event({ billing_date: '2026-07-01', is_scheduled: true, schedule_key: 'plan', cancelled: true })],
      forecast: [forecastDate('2026-07-01')],
    });
    expect(t.points.map((p) => [p.kind, p.status])).toEqual([['forecast', 'forecasted']]);
  });

  it('#3435: a cancelled attempt that collected nothing is not a point, whatever its attempt says', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [
        event({ id: 1, billing_date: '2026-03-01', cancelled: true, latest_tx_status: 'pending' }),
        event({ id: 2, billing_date: '2026-03-02', latest_tx_status: 'cancelled' }),
      ],
      forecast: [],
    });
    expect(t.points).toEqual([]);
  });

  it('#3311 stage 3: an expired attempt that collected nothing is not a point, and its period is not forecast', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [
        event({ id: 1, billing_date: '2026-03-01', latest_tx_status: 'expired' }),
        event({ id: 2, billing_date: '2026-07-01', period_start: '2026-07-01', is_scheduled: true, schedule_key: 'plan', latest_tx_status: 'expired' }),
        event({ id: 3, billing_date: '2026-04-01', latest_tx_status: 'failed' }),
      ],
      forecast: [forecastDate('2026-07-01'), forecastDate('2026-08-01')],
    });
    expect(t.points.map((p) => [p.kind, p.date, p.billing_event_id])).toEqual([
      ['payment', '2026-04-01', 3], ['forecast', '2026-08-01', null],
    ]);
  });

  it('#3311 stage 3: an event that collected money stays a payment whatever a later attempt says', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [event({ billing_date: '2026-03-01', latest_tx_status: 'expired', paid_at: '2026-03-01T10:00:00Z' })],
      forecast: [],
    });
    expect(t.points).toHaveLength(1);
  });

  it('#3435: a cancelled event that did collect money stays a payment', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [event({ billing_date: '2026-03-01', cancelled: true, latest_tx_status: 'completed', paid_at: '2026-03-01T10:00:00Z' })],
      forecast: [],
    });
    expect(t.points).toEqual([expect.objectContaining({ kind: 'payment', status: 'cancelled', alert: null })]);
  });

  it('#3435: marks failed and pending payments, never a paid, scheduled or forecast point', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [
        event({ id: 1, billing_date: '2026-03-01', latest_tx_status: 'failed' }),
        event({ id: 3, billing_date: '2026-05-01', latest_tx_status: 'pending' }),
        event({ id: 4, billing_date: '2026-05-10', latest_tx_status: 'completed', paid_at: '2026-05-10' }),
        event({ id: 5, billing_date: '2026-07-01', is_scheduled: true, schedule_key: 'plan' }),
      ],
      forecast: [forecastDate('2026-08-01')],
    });
    expect(t.points.map((p) => [p.billing_event_id, p.status, p.alert])).toEqual([
      [1, 'failed', 'failed'], [3, 'pending', 'pending'],
      [4, 'paid', null], [5, 'scheduled', null], [null, 'forecasted', null],
    ]);
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

  // #3446 — Scheduled / Forecasted / No charge, matched by obligation rather than by date.

  it('a zero-value cycle is No charge, before, between and after positive cycles', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [],
      forecast: [forecastDate('2026-07-01', 0), forecastDate('2026-08-01', 70), forecastDate('2026-09-01', 0), forecastDate('2026-10-01', 70)],
    });
    expect(t.points.map((p) => [p.kind, p.status, p.billing_event_id])).toEqual([
      ['no_charge', 'no_charge', null], ['forecast', 'forecasted', null],
      ['no_charge', 'no_charge', null], ['forecast', 'forecasted', null],
    ]);
  });

  it('an unrelated persisted event on the same date hides no other schedule\'s forecast', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [event({ id: 9, billing_date: '2026-07-01', period_start: '2026-07-01', is_scheduled: true, schedule_key: 'plan' })],
      forecast: [forecastDate('2026-07-01'), productForecast('2026-07-01', 'product-4w', 5, 20)],
    });
    expect(t.points.map((p) => [p.kind, p.billing_event_id, p.amount])).toEqual([
      ['scheduled', 9, 50], ['forecast', null, 20],
    ]);
  });

  it('matches a persisted obligation by its schedule period, not its billing date', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [event({ id: 3, billing_date: '2026-07-03', period_start: '2026-07-01', is_scheduled: true, schedule_key: 'plan' })],
      forecast: [forecastDate('2026-07-01')],
    });
    expect(t.points.map((p) => p.kind)).toEqual(['scheduled']);
  });

  it('a recurring Product paid up front on that date is not forecast again', () => {
    const t = buildPaymentsTimeline({
      today: TODAY,
      events: [event({ id: 4, billing_date: TODAY, latest_tx_status: 'completed', paid_at: TODAY, product_ids: [5] })],
      forecast: [productForecast(TODAY, 'product-4w', 5, 20), productForecast('2026-07-13', 'product-4w', 5, 20)],
    });
    expect(t.points.map((p) => [p.kind, p.date])).toEqual([['payment', TODAY], ['forecast', '2026-07-13']]);
  });

  it('a one-off obligation (no schedule) is never forecast', () => {
    const t = buildPaymentsTimeline({ today: TODAY, events: [], forecast: [forecastDate('2026-07-01', 30, null)] });
    expect(t.points).toEqual([]);
  });

  it('yearly fee + four-weekly locker: two yearly cycles and the first two locker cycles scheduled, the rest forecasted', () => {
    const yearly = ['2026-07-01', '2027-07-01', '2028-07-01'];
    const locker: string[] = [];
    for (let d = Date.UTC(2026, 6, 1); d <= Date.UTC(2028, 6, 1); d += 28 * 86_400_000) locker.push(new Date(d).toISOString().slice(0, 10));
    const persisted = [
      ...yearly.slice(0, 2).map((d, i) => event({ id: 100 + i, billing_date: d, period_start: d, is_scheduled: true, schedule_key: 'product-year' })),
      ...locker.slice(0, 2).map((d, i) => event({ id: 200 + i, billing_date: d, period_start: d, is_scheduled: true, schedule_key: 'product-4w' })),
    ];
    const forecast = [
      ...yearly.map((d) => productForecast(d, 'product-year', 1, 100)),
      ...locker.map((d) => productForecast(d, 'product-4w', 2, 20)),
    ];
    expect(commonForecastHorizon(forecast)).toBe([...yearly, ...locker].sort().at(-1));
    const t = buildPaymentsTimeline({ today: TODAY, events: persisted, forecast });
    const lockerPoints = t.points.filter((p) => p.lines[0]?.label === 'Product 2' || [200, 201].includes(p.billing_event_id ?? 0));
    expect(t.points.filter((p) => p.kind === 'scheduled')).toHaveLength(4);
    expect(lockerPoints.filter((p) => p.kind === 'forecast')).toHaveLength(locker.length - 2);
    expect(lockerPoints[lockerPoints.length - 1].date > '2028-06-01').toBe(true);
    expect(t.points.filter((p) => p.kind === 'forecast' && p.lines[0].label === 'Product 1').map((p) => p.date)).toEqual(['2028-07-01']);
  });
});
