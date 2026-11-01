import { describe, expect, it } from 'vitest';
import { combinedChartSeries } from '../app/[locale]/members/progressView';

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
