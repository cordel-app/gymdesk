import { describe, expect, it } from 'vitest';
import {
  readingAxisLabel as adminAxisLabel,
  readingChartPoints as adminPoints,
} from '../../../apps/admin/src/components/personalGoals/goalReadings';
import {
  readingAxisLabel as memberAxisLabel,
  readingChartPoints as memberPoints,
} from '../../../apps/member/src/lib/memberGoals';
import { segmentPoints } from '../../../shared/charts/src/series';

// #1037 stage 4 — the adapters that turn an assignment's readings into chart
// points, one per app, and the one thing that must stay true of both: they
// answer the *same* chart for the same rows.
//
// The two apps share no frontend module (the rule `calendarEventPaint.ts` and
// `calendarEventDisplay.ts` follow), so each owns its adapter — but a member and
// the trainer looking at the same goal must not see two different histories, and
// nothing in a type checker says so. This is that gate, and it lives in the API
// suite because CI runs `npm test` in `api/` only (#1009).
//
// Both adapters are pure TypeScript whose only import is a `type`, which is why
// they are importable here at all.

const READINGS = [
  { id: 3, value: 76, recorded_at: '2026-09-22T00:00:00.000Z', is_initial: true, period: 1 },
  { id: 1, value: 80, recorded_at: '2026-09-01T00:00:00.000Z', is_initial: true, period: 0 },
  { id: 2, value: 78, recorded_at: '2026-09-08T09:30:00.000Z', is_initial: false, period: 0 },
];

describe('readings as chart points', () => {
  it('is chronological whatever order the rows arrive in (§17)', () => {
    const points = memberPoints(READINGS, 'kg', 'en-GB');
    expect(points.map((p) => p.y)).toEqual([80, 78, 76]);
    expect(points.map((p) => p.x)).toEqual([
      Date.parse('2026-09-01T00:00:00.000Z'),
      Date.parse('2026-09-08T09:30:00.000Z'),
      Date.parse('2026-09-22T00:00:00.000Z'),
    ]);
  });

  it('carries the server’s own period, so neither app decides where one starts (§38)', () => {
    expect(memberPoints(READINGS, 'kg', 'en-GB').map((p) => p.group)).toEqual([0, 0, 1]);
  });

  it('labels each point with its date and its value, in the reader’s locale (§16)', () => {
    const [first, second] = memberPoints(READINGS, 'kg', 'en-GB');
    expect(first.valueLabel).toBe('80 kg');
    // A midnight reading shows no time; one with a real time does, which is what
    // keeps two readings on one date legible as two rows.
    expect(first.label).not.toMatch(/00:00/);
    expect(second.label).toMatch(/09:30/);
  });

  it('drops a row with no value or no timestamp rather than plotting it at zero (§14)', () => {
    const points = memberPoints([
      { id: 1, value: null, recorded_at: '2026-09-01T00:00:00.000Z', is_initial: true, period: 0 },
      { id: 2, value: 70, recorded_at: null, is_initial: false, period: 0 },
    ], 'kg', 'en-GB');
    expect(points).toEqual([]);
  });

  it('is the same chart in both apps', () => {
    // Different modules, one answer: the x, y and group of every point, and the
    // labels, for the same rows and the same locale.
    expect(adminPoints(READINGS, 'kg', 'en-GB')).toEqual(memberPoints(READINGS, 'kg', 'en-GB'));
    expect(adminAxisLabel(Date.parse('2026-09-22T00:00:00.000Z'), 'en-GB'))
      .toBe(memberAxisLabel(Date.parse('2026-09-22T00:00:00.000Z'), 'en-GB'));
    expect(adminPoints([], null, 'en-GB')).toEqual(memberPoints([], null, 'en-GB'));
  });

  it('quotes a value with no unit as a bare number, in both apps', () => {
    expect(memberPoints(READINGS, null, 'en-GB')[0].valueLabel).toBe('80');
    expect(adminPoints(READINGS, null, 'en-GB')[0].valueLabel).toBe('80');
  });

  it('answers an empty axis label for an unusable instant rather than throwing', () => {
    expect(memberAxisLabel(Number.NaN, 'en-GB')).toBe('');
    expect(adminAxisLabel(Number.NaN, 'en-GB')).toBe('');
  });
});

describe('the segmented line a changed initial reading produces (§21–§24)', () => {
  it('is one series per initial-reading period, joined at the boundary', () => {
    const series = segmentPoints(memberPoints(READINGS, 'kg', 'en-GB'));
    expect(series).toHaveLength(2);
    expect(series[0].points.map((p) => p.y)).toEqual([80, 78]);
    // The new period starts from the last reading of the old one, so the line
    // does not break where the baseline moved — and that repeat draws no symbol.
    expect(series[1].points.map((p) => p.y)).toEqual([78, 76]);
    expect(series[1].bridgeCount).toBe(1);
    expect(series.map((s) => s.colorIndex)).toEqual([0, 1]);
  });

  it('is one series while the baseline has never moved', () => {
    const one = segmentPoints(memberPoints(
      READINGS.filter((r) => r.period === 0), 'kg', 'en-GB',
    ));
    expect(one).toHaveLength(1);
    expect(one[0].bridgeCount).toBe(0);
  });

  it('keeps every historical reading when the baseline moves (§28)', () => {
    const points = memberPoints(READINGS, 'kg', 'en-GB');
    const drawn = segmentPoints(points).flatMap((s) => s.points.slice(s.bridgeCount ?? 0));
    expect(drawn.map((p) => p.y)).toEqual([80, 78, 76]);
  });
});
