import { describe, expect, it } from 'vitest';
import {
  cardBackgroundStyle, daysNewestFirst, formatBestResult, progressChartPoints, resultUnitKey,
} from '../../../apps/member/src/lib/memberProgress';

// #1224 — My Progress (Members App). The figures are the API's; this pins what
// the app decides: `—` for no data, the unit key, a gap for a day with no value.
describe('Members App progress (#1224)', () => {
  it('reads no best result as — and never 0', () => {
    expect(formatBestResult(null, 'kg')).toBe('—');
    expect(formatBestResult({ slug: 'weight', value: 80 }, 'kg')).toContain('80');
  });

  it('maps only measured result types to a unit', () => {
    expect(resultUnitKey('weight')).toBe('progress.unit_kg');
    expect(resultUnitKey('pace')).toBeNull();
  });

  it('plots a day without a value as a gap', () => {
    const days = [
      { logged_date: '2026-10-01', max_weight: 70, value: 70, duration_seconds: null, sets: [] },
      { logged_date: '2026-10-05', max_weight: null, value: null, duration_seconds: null, sets: [] },
    ];
    const pts = progressChartPoints(days, 'kg');
    expect(pts.map((p) => p.y)).toEqual([70, null]);
    expect(daysNewestFirst(days)[0].logged_date).toBe('2026-10-05');
  });

  it('puts the image under a scrim of the card surface, or nothing', () => {
    expect(cardBackgroundStyle(null, 'var(--s)')).toEqual({});
    const s = cardBackgroundStyle('https://x/y.webp', 'var(--s)');
    expect(s.backgroundImage).toContain('color-mix');
    expect(s.backgroundSize).toBe('cover');
  });
});
