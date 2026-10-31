// #1231 — the staff Progress tab's pure decisions: types, chart points and the edit payload.
// The figures are the API's (`domain/exerciseProgress.ts`); nothing here computes one.
import type { ChartPoint } from '@gymdesk/charts';
import { DEFAULT_GYM_FORMAT, formatGymDayMonth, formatGymNumber, type GymFormatSettings } from '@/lib/gymFormat';

export interface ProgressSet { id?: number; set_number: number; weight: number | null; reps: number | null; rpe?: number | null }

export interface ProgressSummary {
  exercise_id: number;
  exercise_name: string;
  image_url?: string | null;
  image_thumbnail_url?: string | null;
  days_exercised: number;
  max_weight: number | null;
  result_kind: { id: number; slug: string } | null;
  best_result: { slug: 'weight' | 'repetitions' | 'duration'; value: number } | null;
  /** #2179 — one best result per metric the exercise's category supports. */
  metrics: ProgressMetricBest[];
}

export type ProgressMetricSlug = 'weight' | 'repetitions';
export interface ProgressMetricBest { slug: ProgressMetricSlug; value: number | null }
export interface ProgressMetricDays { slug: ProgressMetricSlug; days: ProgressDay[] }

export interface ProgressDay { logged_date: string; value: number | null }

export interface ProgressReading {
  id: number;
  logged_date: string;
  notes: string | null;
  duration_seconds: number | null;
  skipped: boolean;
  sets: Required<Pick<ProgressSet, 'id' | 'set_number' | 'weight' | 'reps'>>[];
}

export interface ProgressDetail extends ProgressSummary { days: ProgressDay[]; metric_days: ProgressMetricDays[]; readings: ProgressReading[] }

/** Locale key of the unit a best result is shown with; `null` is a bare number. */
export function resultUnitKey(slug: string | null | undefined): string | null {
  if (slug === 'weight') return 'members.progress_unit_kg';
  if (slug === 'repetitions') return 'members.progress_unit_reps';
  if (slug === 'duration') return 'members.progress_unit_seconds';
  return null;
}

/** Locale key of a metric's best-result label. */
export function metricLabelKey(slug: ProgressMetricSlug): string {
  return slug === 'weight' ? 'members.progress_best_weight' : 'members.progress_best_reps';
}

/** `—` for anything the logs hold no data for — never 0. */
export function formatValue(value: number | null, unit: string | null, gym: GymFormatSettings = DEFAULT_GYM_FORMAT): string {
  if (value === null || value === undefined) return '—';
  const n = formatGymNumber(value, gym);
  return unit ? `${n} ${unit}` : n;
}

export function progressChartPoints(days: ProgressDay[], unit: string | null, gym: GymFormatSettings = DEFAULT_GYM_FORMAT): ChartPoint[] {
  return days.map((d) => ({
    x: Date.parse(`${d.logged_date}T00:00:00Z`),
    y: d.value,
    group: 0,
    label: formatGymDayMonth(d.logged_date, gym),
    valueLabel: d.value === null ? undefined : formatValue(d.value, unit, gym),
  }));
}

export interface ReadingDraft {
  notes: string;
  duration: string;
  sets: Array<{ id: number; weight: string; reps: string }>;
}

const text = (v: number | null) => (v === null ? '' : String(v));

export function draftFromReading(r: ProgressReading): ReadingDraft {
  return {
    notes: r.notes ?? '',
    duration: text(r.duration_seconds),
    sets: r.sets.map((s) => ({ id: s.id, weight: text(s.weight), reps: text(s.reps) })),
  };
}

/** `null` when the draft holds a value the API would refuse (the date is never editable). */
export function readingPayload(d: ReadingDraft): Record<string, unknown> | null {
  const num = (v: string): number | null | undefined => {
    if (v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const duration = num(d.duration);
  if (duration === undefined) return null;
  const sets = [];
  for (const s of d.sets) {
    const weight = num(s.weight);
    const reps = num(s.reps);
    if (weight === undefined || reps === undefined || (reps !== null && !Number.isInteger(reps))) return null;
    sets.push({ id: s.id, weight, reps });
  }
  return { notes: d.notes, duration_seconds: duration, sets };
}
