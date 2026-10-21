// #1224 — **My Progress**: everything the progress tab decides, with no JSX.
//
// The page renders, this module decides: which locale key names a result type,
// how a best result reads, what the chart plots. The figures themselves are the
// API's (`domain/exerciseProgress.ts`) — nothing here computes a best result,
// a day count or a maximum.
import type { ChartPoint } from '@gymdesk/charts';
import { DEFAULT_GYM_FORMAT, formatGymDayMonth, formatGymNumber, type GymFormatSettings } from './gymFormat';

export interface ProgressSet { set_number: number; weight: number | null; reps: number | null }

export interface ProgressSummary {
  exercise_id: number;
  exercise_name: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
  days_exercised: number;
  max_weight: number | null;
  result_kind: { id: number; slug: string } | null;
  best_result: { slug: 'weight' | 'repetitions' | 'duration'; value: number } | null;
}

export interface ProgressDay {
  logged_date: string;
  max_weight: number | null;
  value: number | null;
  duration_seconds: number | null;
  sets: ProgressSet[];
}

export interface ProgressDetail extends Omit<ProgressSummary, 'image_url' | 'image_thumbnail_url'> {
  days: ProgressDay[];
}

/** The unit a best result is shown with: a locale key, or `null` for a bare number. */
export function resultUnitKey(slug: string | null | undefined): string | null {
  if (slug === 'weight') return 'progress.unit_kg';
  if (slug === 'repetitions') return 'progress.unit_reps';
  if (slug === 'duration') return 'progress.unit_seconds';
  return null;
}

/** `—` is the answer for anything the logs hold no data for — never `0`. */
export function formatBestResult(
  best: ProgressSummary['best_result'],
  unit: string | null,
  gym: GymFormatSettings = DEFAULT_GYM_FORMAT,
): string {
  if (!best) return '—';
  const n = formatGymNumber(best.value, gym);
  return unit ? `${n} ${unit}` : n;
}

export function formatMaxWeight(value: number | null, unit: string, gym: GymFormatSettings = DEFAULT_GYM_FORMAT): string {
  return value === null ? '—' : `${formatGymNumber(value, gym)} ${unit}`;
}

/** One chart point per day, in the exercise's own result type; a day with no value is a gap. */
export function progressChartPoints(days: ProgressDay[], unit: string | null, gym: GymFormatSettings = DEFAULT_GYM_FORMAT): ChartPoint[] {
  return days.map((d) => ({
    x: Date.parse(`${d.logged_date}T00:00:00Z`),
    y: d.value,
    group: 0,
    label: formatGymDayMonth(d.logged_date, gym),
    valueLabel: d.value === null ? undefined : (unit ? `${formatGymNumber(d.value, gym)} ${unit}` : formatGymNumber(d.value, gym)),
  }));
}

/** Newest first, for the table under the chart. */
export function daysNewestFirst(days: ProgressDay[]): ProgressDay[] {
  return [...days].sort((a, b) => b.logged_date.localeCompare(a.logged_date));
}

/** Cell value, `—` when the set recorded none. */
export function formatSetValue(value: number | null, gym: GymFormatSettings = DEFAULT_GYM_FORMAT): string {
  return value === null ? '—' : formatGymNumber(value, gym);
}
