// #1231 — the staff Progress tab's pure decisions: types, chart points and the edit payload.
// The figures are the API's (`domain/exerciseProgress.ts`); nothing here computes one.
import type { ChartPoint, ChartSeries } from '@gymdesk/charts';
import { DEFAULT_GYM_FORMAT, formatGymDayMonth, formatGymNumber, type GymFormatSettings } from '@/lib/gymFormat';

export interface ProgressSet { id?: number; set_number: number; weight: number | null; reps: number | null; rpe?: number | null }

export interface ProgressSummary {
  exercise_id: number;
  exercise_name: string;
  image_url?: string | null;
  image_thumbnail_url?: string | null;
  /** #2295 — the exercise's full description in the request language. */
  description?: string | null;
  days_exercised: number;
  max_weight: number | null;
  result_kind: { id: number; slug: string } | null;
  best_result: { slug: 'weight' | 'repetitions' | 'duration'; value: number } | null;
  /** #2179 — one best result per metric the exercise's category supports. */
  metrics: ProgressMetricBest[];
  /** #2198 — the logs are member-authored: the author, the first log's creation and the latest edit. */
  created_at?: string | null;
  created_by?: string | null;
  modified_at?: string | null;
  modified_by?: string | null;
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

export interface ProgressDetail extends ProgressSummary {
  days: ProgressDay[];
  metric_days: ProgressMetricDays[];
  readings: ProgressReading[];
  /** #2628 — the values the exercise is configured to record (the API's `readingFields()`). */
  recorded_fields?: ReadingField[];
}

/** #2628 — a value a reading form may offer: per-set weight and repetitions, the log's duration. */
export type ReadingField = 'weight' | 'repetitions' | 'duration';
const ALL_READING_FIELDS: readonly ReadingField[] = ['weight', 'repetitions', 'duration'];

/**
 * #2628 — the fields the edit form shows: the API's list, in its order. A response without
 * one (or an empty one) shows all three, so no stored value becomes uneditable.
 */
export function readingFieldsOf(detail: Pick<ProgressDetail, 'recorded_fields'> | null | undefined): ReadingField[] {
  const fields = (detail?.recorded_fields ?? []).filter((f) => ALL_READING_FIELDS.includes(f));
  return fields.length > 0 ? fields : [...ALL_READING_FIELDS];
}

/**
 * #2628 — the fields the add form shows. A new reading is one set (`POST …/readings` takes
 * weight and reps, never a duration), so it offers the configured set fields, and both when
 * the exercise records neither.
 */
export function addReadingFieldsOf(fields: ReadingField[]): Array<'weight' | 'repetitions'> {
  const setFields = fields.filter((f): f is 'weight' | 'repetitions' => f !== 'duration');
  return setFields.length > 0 ? setFields : ['weight', 'repetitions'];
}

/** Locale key of the unit a best result is shown with; `null` is a bare number. */
export function resultUnitKey(slug: string | null | undefined): string | null {
  if (slug === 'weight') return 'members.progress_unit_kg';
  if (slug === 'repetitions') return 'members.progress_unit_reps';
  if (slug === 'duration') return 'members.progress_unit_seconds';
  return null;
}

/** Locale key of a metric's best-result label. */
export function metricLabelKey(slug: ProgressMetricSlug): string {
  return slug === 'weight' ? 'members.progress_max_weight_result' : 'members.progress_max_reps_result';
}

/** `—` for anything the logs hold no data for — never 0. */
export function formatValue(value: number | null, unit: string | null, gym: GymFormatSettings = DEFAULT_GYM_FORMAT): string {
  if (value === null || value === undefined) return '—';
  const n = formatGymNumber(value, gym);
  return unit ? `${n} ${unit}` : n;
}

export function progressChartPoints(days: ProgressDay[], unit: string | null, gym: GymFormatSettings = DEFAULT_GYM_FORMAT): ChartPoint[] {
  return days.map((d) => ({
    x: readingChartX(d.logged_date),
    y: d.value,
    group: 0,
    label: formatGymDayMonth(d.logged_date, gym),
    valueLabel: d.value === null ? undefined : formatValue(d.value, unit, gym),
  }));
}

/** The chart's x for a reading's day — the very value `progressChartPoints()` gives that day's point. */
export function readingChartX(loggedDate: string): number {
  return Date.parse(`${loggedDate}T00:00:00Z`);
}

/** Readings of the same day, kept together in the order the API sent them (#2178). */
export function groupReadingsByDate(readings: ProgressReading[]): Array<{ date: string; readings: ProgressReading[] }> {
  const groups: Array<{ date: string; readings: ProgressReading[] }> = [];
  for (const r of readings) {
    const last = groups[groups.length - 1];
    if (last && last.date === r.logged_date) last.readings.push(r);
    else groups.push({ date: r.logged_date, readings: [r] });
  }
  return groups;
}

/**
 * #2223 — the flag of one day: its date, the number of sets and the day's own Max per
 * metric. Computed from that day's readings only; the exercise's overall Max is the API's.
 */
export function dayFlagLines(
  date: string,
  readings: ProgressReading[],
  labels: { sets: (n: number) => string; maxWeight: (v: string) => string; maxReps: (v: string) => string },
  gym: GymFormatSettings = DEFAULT_GYM_FORMAT,
  units: { kg: string; reps: string } = { kg: 'kg', reps: 'reps' },
): string[] {
  const sets = readings.filter((r) => r.logged_date === date && !r.skipped).flatMap((r) => r.sets);
  if (sets.length === 0) return [];
  const max = (values: Array<number | null>) => {
    const nums = values.filter((v): v is number => v !== null);
    return nums.length > 0 ? Math.max(...nums) : null;
  };
  const lines = [formatGymDayMonth(date, gym), labels.sets(sets.length)];
  const w = max(sets.map((s) => s.weight));
  const r = max(sets.map((s) => s.reps));
  if (w !== null) lines.push(labels.maxWeight(formatValue(w, units.kg, gym)));
  if (r !== null) lines.push(labels.maxReps(formatValue(r, units.reps, gym)));
  return lines;
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

/**
 * `null` when the draft holds a value the API would refuse (the date is never editable).
 * #2628 — a field the form does not show is left out, so the API keeps what it stores.
 */
export function readingPayload(d: ReadingDraft, fields: ReadingField[] = [...ALL_READING_FIELDS]): Record<string, unknown> | null {
  const num = (v: string): number | null | undefined => {
    if (v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const payload: Record<string, unknown> = { notes: d.notes };
  if (fields.includes('duration')) {
    const duration = num(d.duration);
    if (duration === undefined) return null;
    payload.duration_seconds = duration;
  }
  const withWeight = fields.includes('weight');
  const withReps = fields.includes('repetitions');
  if (withWeight || withReps) {
    const sets = [];
    for (const s of d.sets) {
      const set: Record<string, unknown> = { id: s.id };
      if (withWeight) {
        const weight = num(s.weight);
        if (weight === undefined) return null;
        set.weight = weight;
      }
      if (withReps) {
        const reps = num(s.reps);
        if (reps === undefined || (reps !== null && !Number.isInteger(reps))) return null;
        set.reps = reps;
      }
      sets.push(set);
    }
    payload.sets = sets;
  }
  return payload;
}

/**
 * #2198 — every supported metric in one chart. The first metric reads the left axis and the
 * next the right one, so kg and reps stay readable together; each series is named with its
 * label and unit for the legend. A metric with no reading at all is left out.
 */
export function combinedChartSeries(
  metrics: ProgressMetricDays[],
  label: (slug: ProgressMetricSlug) => string,
  unit: (slug: ProgressMetricSlug) => string,
  gym: GymFormatSettings = DEFAULT_GYM_FORMAT,
  flagFor?: (loggedDate: string) => string[],
): ChartSeries[] {
  return metrics
    .filter((m) => m.days.some((d) => d.value !== null))
    .map((m, index) => ({
      id: `metric-${m.slug}`,
      name: `${label(m.slug)} (${unit(m.slug)})`,
      colorIndex: index,
      axis: (index === 0 ? 0 : 1) as 0 | 1,
      // The flag is drawn from the first series only, so two series never stack two flags on one day.
      points: progressChartPoints(m.days, unit(m.slug), gym).map((p, i) => {
        const lines = index === 0 && flagFor ? flagFor(m.days[i].logged_date) : [];
        return lines.length > 0 ? { ...p, flagLines: lines } : p;
      }),
    }));
}

/**
 * #2198 — the legend isolates one metric: with a `focusId` only that series is drawn, on the
 * left axis, so the axis rescales to it; `null` (or an id no series has) draws them all.
 */
export function focusChartSeries(series: ChartSeries[], focusId: string | null): ChartSeries[] {
  const focused = focusId === null ? undefined : series.find((s) => s.id === focusId);
  if (!focused) return series;
  return [{ ...focused, axis: 0 as const }];
}

/** A tapped legend entry isolates its metric; tapping the isolated one shows them all again. */
export function toggleFocus(current: string | null, id: string): string | null {
  return current === id ? null : id;
}

export interface AddReadingDraft { date: string; reps: string; weight: string }

/** `null` when the draft holds something the API would refuse: no date, nothing measured, fractional reps. */
export function addReadingPayload(d: AddReadingDraft): { logged_date: string; reps: number | null; weight: number | null } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return null;
  const num = (v: string): number | null | undefined => {
    if (v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const reps = num(d.reps);
  const weight = num(d.weight);
  if (reps === undefined || weight === undefined) return null;
  if (reps !== null && !Number.isInteger(reps)) return null;
  if (reps === null && weight === null) return null;
  return { logged_date: d.date, reps, weight };
}
