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
  /** #2284 — the latest performed day (`YYYY-MM-DD`), and the muscle slugs the exercise works. */
  last_logged_date: string | null;
  muscles: string[];
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

export interface ProgressDetail extends Omit<ProgressSummary, 'image_url' | 'image_thumbnail_url' | 'last_logged_date' | 'muscles'> {
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

// #2284 — the My Progress filters. Pure: the list is the API's, this only narrows it.
export type ProgressDateRange = 'all' | 'week' | 'month';
export interface ProgressFilters { exerciseId: number | null; muscle: string | null; range: ProgressDateRange }
export const NO_PROGRESS_FILTERS: ProgressFilters = { exerciseId: null, muscle: null, range: 'all' };
const RANGE_DAYS: Record<Exclude<ProgressDateRange, 'all'>, number> = { week: 7, month: 30 };

/** Today's calendar date (`YYYY-MM-DD`) in the gym's time zone. */
export function gymToday(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

export function filterProgress(
  items: ProgressSummary[], f: ProgressFilters, today: string,
): ProgressSummary[] {
  return items.filter((i) => {
    if (f.exerciseId !== null && i.exercise_id !== f.exerciseId) return false;
    if (f.muscle !== null && !(i.muscles ?? []).includes(f.muscle)) return false;
    if (f.range !== 'all') {
      if (!i.last_logged_date) return false;
      const age = dayNumber(today) - dayNumber(i.last_logged_date);
      if (age < 0 || age >= RANGE_DAYS[f.range]) return false;
    }
    return true;
  });
}

/** The muscles present in the member's own list, sorted by slug. */
export function progressMuscles(items: ProgressSummary[]): string[] {
  return [...new Set(items.flatMap((i) => i.muscles ?? []))].sort();
}

export function muscleLabel(slug: string): string {
  const s = slug.replace(/[_-]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : slug;
}
