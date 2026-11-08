import { describe, expect, it } from 'vitest';
import { addReadingPayload, combinedChartSeries, focusChartSeries, toggleFocus } from '../app/[locale]/members/progressView';

// #2198 — every supported metric shares one chart: kg on the left axis, reps on the right.
describe('combinedChartSeries', () => {
  const metrics = [
    { slug: 'weight' as const, days: [{ logged_date: '2026-10-01', value: 60 }, { logged_date: '2026-10-03', value: 80 }] },
    { slug: 'repetitions' as const, days: [{ logged_date: '2026-10-01', value: 10 }, { logged_date: '2026-10-03', value: 3 }] },
  ];
  const label = (s: string) => (s === 'weight' ? 'Weight' : 'Repetitions');
  const unit = (s: string) => (s === 'weight' ? 'kg' : 'reps');

  it('builds one named series per metric on separate axes', () => {
    const out = combinedChartSeries(metrics, label, unit);
    expect(out.map((s) => s.name)).toEqual(['Weight (kg)', 'Repetitions (reps)']);
    expect(out.map((s) => s.axis)).toEqual([0, 1]);
    expect(out[0].points[1].valueLabel).toContain('80');
  });

  it('leaves out a metric with no reading', () => {
    const out = combinedChartSeries([metrics[0], { slug: 'repetitions', days: [{ logged_date: '2026-10-01', value: null }] }], label, unit);
    expect(out).toHaveLength(1);
  });
});

// #2223 — the hovered day's flag: sets and that day's own Max, never the overall one.
import { dayFlagLines } from '../app/[locale]/members/progressView';
describe('dayFlagLines', () => {
  const labels = { sets: (n: number) => `Sets: ${n}`, maxWeight: (v: string) => `Max Weight: ${v}`, maxReps: (v: string) => `Max Repetitions: ${v}` };
  const reading = (date: string, sets: Array<[number, number]>) => ({
    id: 1, logged_date: date, notes: null, duration_seconds: null, skipped: false,
    sets: sets.map(([reps, weight], i) => ({ id: i, set_number: i + 1, reps, weight })),
  });
  it('counts sets and takes the day maxima', () => {
    const lines = dayFlagLines('2026-10-01', [reading('2026-10-01', [[9, 6], [6, 3], [6, 2]]), reading('2026-10-02', [[20, 100]])], labels);
    expect(lines.slice(1)).toEqual(['Sets: 3', 'Max Weight: 6 kg', 'Max Repetitions: 9 reps']);
  });
  it('is empty for a day without sets', () => {
    expect(dayFlagLines('2026-10-01', [], labels)).toEqual([]);
  });
});

describe('legend focus and Add reading (#2198 follow-up)', () => {
  const series = combinedChartSeries(
    [
      { slug: 'weight' as const, days: [{ logged_date: '2026-10-01', value: 60 }] },
      { slug: 'repetitions' as const, days: [{ logged_date: '2026-10-01', value: 10 }] },
    ],
    (s) => s, (s) => s,
  );

  it('isolates one metric on the left axis, and shows all again when nothing is focused', () => {
    const only = focusChartSeries(series, 'metric-repetitions');
    expect(only).toHaveLength(1);
    expect(only[0].axis).toBe(0);
    expect(focusChartSeries(series, null)).toHaveLength(2);
    expect(focusChartSeries(series, 'unknown')).toHaveLength(2);
  });

  it('toggles the focus off when the isolated entry is tapped again', () => {
    expect(toggleFocus(null, 'a')).toBe('a');
    expect(toggleFocus('a', 'a')).toBeNull();
    expect(toggleFocus('a', 'b')).toBe('b');
  });

  it('builds the add-reading payload only for something the API accepts', () => {
    expect(addReadingPayload({ date: '2026-10-05', reps: '8', weight: '52.5' })).toEqual({ logged_date: '2026-10-05', reps: 8, weight: 52.5 });
    expect(addReadingPayload({ date: '2026-10-05', reps: '', weight: '40' })).toEqual({ logged_date: '2026-10-05', reps: null, weight: 40 });
    expect(addReadingPayload({ date: '2026-10-05', reps: '', weight: '' })).toBeNull();
    expect(addReadingPayload({ date: '', reps: '5', weight: '' })).toBeNull();
    expect(addReadingPayload({ date: '2026-10-05', reps: '2.5', weight: '' })).toBeNull();
    expect(addReadingPayload({ date: '2026-10-05', reps: '-1', weight: '' })).toBeNull();
  });
});
