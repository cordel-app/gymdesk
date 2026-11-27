import { describe, expect, it } from 'vitest';
import {
  type PaymentsTimeline, dateToX, knownStatusKey, monthTickLabel, pointsAtX, timelineSeries,
} from '../app/[locale]/members/paymentsTimelineView';

// #3311 — the Member card's Payments History and Forecast, as chart input.

const timeline: PaymentsTimeline = {
  today: '2026-06-15',
  points: [
    { kind: 'payment', date: '2026-03-04', amount: 70, status: 'paid', billing_event_id: 1, name: 'Gym - March', event_type: 'payment_recorded', lines: [{ label: 'Fee', quantity: 1, amount: 70 }] },
    { kind: 'payment', date: '2026-05-02', amount: 15, status: 'paid', billing_event_id: 2, name: null, event_type: 'product_purchase', lines: [] },
    { kind: 'scheduled', date: '2026-07-01', amount: 70, status: 'scheduled', billing_event_id: 3, name: null, event_type: 'payment_recorded', lines: [] },
    { kind: 'forecast', date: '2026-08-01', amount: 70, status: 'forecasted', billing_event_id: null, name: null, event_type: null, lines: [{ label: 'Fee', quantity: 1, amount: 70 }] },
    { kind: 'no_charge', date: '2026-09-01', amount: 0, status: 'no_charge', billing_event_id: null, name: null, event_type: null, lines: [{ label: 'Fee', quantity: 1, amount: 0 }] },
  ],
};

const labels = {
  date: (d: string) => `D${d}`,
  money: (n: number) => `€${n}`,
  status: (p: { status: string | null }) => p.status ?? 'forecast',
};

describe('Payments History and Forecast chart input', () => {
  it('#3311 stage 4: draws every kind on one line, in date order, with no name and one colour', () => {
    const series = timelineSeries(timeline, labels);
    expect(series).toHaveLength(1);
    expect(series[0].name).toBeUndefined();
    expect(series[0].colorIndex).toBe(0);
    expect(series[0].dashed).toBeFalsy();
    expect(series[0].points.map((p) => p.x)).toEqual(timeline.points.map((p) => dateToX(p.date)));
  });

  it('#3311 stage 4: tells the kinds apart by marker, not by series', () => {
    const [line] = timelineSeries(timeline, labels);
    expect(line.points.map((p) => p.symbol)).toEqual(['circle', 'circle', 'diamond', 'emptyCircle', 'emptyDiamond']);
  });

  it('#3499: every tooltip is headed by its status alone, and carries only its lines between date and total', () => {
    const [line] = timelineSeries(timeline, labels);
    expect(line.points.map((p) => p.heading)).toEqual(['paid', 'paid', 'scheduled', 'forecasted', 'no_charge']);
    expect(line.points.map((p) => p.detailLines)).toEqual([
      ['Fee × 1: €70'], [], [], ['Fee × 1: €70'], ['Fee × 1: €0'],
    ]);
    expect(line.points[4]).toMatchObject({ label: 'D2026-09-01', valueLabel: '€0' });
  });

  it('sorts points the API handed out of date order', () => {
    const shuffled = { ...timeline, points: [timeline.points[3], timeline.points[0], timeline.points[2]] };
    const [line] = timelineSeries(shuffled, labels);
    expect(line.points.map((p) => p.x)).toEqual(['2026-03-04', '2026-07-01', '2026-08-01'].map(dateToX));
  });

  it('places each point at its own date with the labels the page formatted', () => {
    const [line] = timelineSeries(timeline, labels);
    expect(line.points[0]).toMatchObject({
      x: dateToX('2026-03-04'), y: 70, label: 'D2026-03-04', valueLabel: '€70',
      heading: 'paid', detailLines: ['Fee × 1: €70'],
    });
  });

  it('a one-off Product is exactly one point', () => {
    const all = timelineSeries(timeline, labels).flatMap((s) => s.points);
    expect(all.filter((p) => p.x === dateToX('2026-05-02'))).toHaveLength(1);
  });

  it('an empty timeline is one empty line', () => {
    const series = timelineSeries({ today: '2026-06-15', points: [] }, labels);
    expect(series.map((s) => s.points.length)).toEqual([0]);
  });

  it('labels the axis by month in the gym date format', () => {
    expect(monthTickLabel(dateToX('2026-03-04'), { date_format: 'DD/MM/YYYY' })).toBe('03/2026');
    expect(monthTickLabel(dateToX('2026-03-04'), { date_format: 'YYYY-MM-DD' })).toBe('2026-03');
  });

  it('lists the points a selected date carries, and none without a selection', () => {
    expect(pointsAtX(timeline, dateToX('2026-07-01')).map((p) => p.billing_event_id)).toEqual([3]);
    expect(pointsAtX(timeline, null)).toEqual([]);
  });

  it('reads a status under its own key, a forecast as Forecasted, a zero cycle as No charge, anything else as unknown', () => {
    expect(knownStatusKey(timeline.points[0])).toBe('timeline_status_paid');
    expect(knownStatusKey(timeline.points[2])).toBe('timeline_status_scheduled');
    expect(knownStatusKey(timeline.points[3])).toBe('timeline_status_forecasted');
    expect(knownStatusKey(timeline.points[4])).toBe('timeline_status_no_charge');
    expect(knownStatusKey({ ...timeline.points[0], status: 'weird' })).toBe('timeline_status_unknown');
  });
});
