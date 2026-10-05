/**
 * #1037 stage 3 — what an Assigned Personal Goal's **readings** are on the
 * admin side: the five header fields §5 lists, the shape of a reading row, the
 * way a value, a percentage and a timestamp are written, which rows carry the
 * `Initial` marker, and what the Add reading dialog submits.
 *
 * It is the frontend counterpart of `api/src/domain/goalReadings.ts` and
 * deliberately **computes nothing it could read**: `initial_reading`,
 * `latest_reading` and `progress_percent` ride on every assignment-shaped
 * response of both routers (stage 2), so a page that divided three numbers for
 * itself would be the second place deciding a percentage — which is the whole
 * reason that module exists. Everything here is formatting, ordering and
 * validation.
 *
 * It lives beside `assignedPersonalGoalProfile.ts` for the same reason that file
 * does: the entity is administered from **two** screens (the gym-wide Assigned
 * Personal Goals section and the Member card's PERSONAL GOALS section), so the
 * shared declaration moves up rather than sideways (#799/#806). The Members App
 * has its own copy in `apps/member/src/lib/memberGoals.ts`, because the two apps
 * share no frontend module — the rule `calendarEventPaint.ts` already follows.
 *
 * It is JSX- and i18n-free: every label is a **key** the calling page resolves
 * in its own namespace (#901).
 */

import type { ChartPoint } from '@gymdesk/charts';

/**
 * §5 — the five fields of the card header, in order, each as the key its own
 * page resolves.
 *
 * One declaration rather than five hard-coded cells, so the two surfaces cannot
 * show four fields and five, and so §6's "do not create a new visual language"
 * is satisfied by there being one grid to change.
 *
 * `GOAL` is first and is part of the header rather than a separate card title:
 * a card whose name is rendered twice, once as a heading and once as a labelled
 * field, is the pipe-separated sentence §5 rejects wearing a different shape.
 */
export const GOAL_READING_FIELDS = [
  'label_goal',
  'label_initial_reading',
  'label_target',
  'label_latest_reading',
  'label_progress',
] as const;

/** The six computed fields every assignment-shaped read reports (stage 2). */
export interface GoalReadingSummaryFields {
  /** §8 — the value of the **currently active** initial reading, not the first. */
  initial_reading: number | null;
  /** When that reading was taken, ISO 8601 UTC. */
  initial_reading_at: string | null;
  /** §10 — the most recent reading, whatever period it falls in. */
  latest_reading: number | null;
  latest_reading_at: string | null;
  /** §11 — 0..100, or `null` when it cannot be computed (no readings, no target). */
  progress_percent: number | null;
  reading_count: number;
}

/** One row of `GET /member-personal-goals/:id/readings`. */
export interface GoalReadingRow {
  id: number;
  value: number | null;
  /** ISO 8601 UTC — the one format stage 2 reports every instant in. */
  recorded_at: string | null;
  /** §21 — whether this reading opens an initial-reading period. */
  is_initial: boolean;
  /** §38 — which period it falls in, 0-based. Read by the chart (stage 4). */
  period: number;
  created_by_name?: string | null;
  created_by_type?: string | null;
}

export interface GoalReadingsResponse extends GoalReadingSummaryFields {
  readings: GoalReadingRow[];
}

/** The two writers stage 2 exposes, as the path each appends to the router root. */
export const READING_ENDPOINTS = {
  reading: 'readings',
  initial: 'initial-reading',
} as const;

/** Which of the two a dialog is open for. They are two actions, never a flag. */
export type ReadingKind = keyof typeof READING_ENDPOINTS;

/**
 * A reading or a target as one phrase — `75 kg`, `75` for a value with no unit,
 * `—` for none at all.
 *
 * `—` and `0` are different facts: a goal with no readings has no initial
 * reading, while `0 kg` is a legitimate measurement (and `0` is a legitimate
 * Maintenance target, #1034 §2), so the check is `=== null` and never falsiness.
 * Trailing zeros are trimmed for `formatTarget()`'s reason — the column is a
 * DECIMAL(10,2) and `75.00 kg` claims a precision nobody typed.
 */
export function formatReadingValue(value: number | null | undefined, unit: string | null): string {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const text = String(Number(n.toFixed(2)));
  return unit ? `${text} ${unit}` : text;
}

/**
 * §11/§27 — the progress figure, already clamped to 0..100 by the server.
 *
 * `null` reads as `—` and never `0%`: an assignment with no readings has made no
 * progress *and* recorded none, and reporting the second as the first would tell
 * a member they are getting nowhere when nobody has weighed them yet.
 *
 * The number is printed as it comes rather than rounded to a whole: the server
 * already rounds to one decimal, and rounding `99.9` up here would read `100%`
 * on a goal that is not finished.
 */
export function formatProgress(percent: number | null | undefined): string {
  if (percent === null || percent === undefined) return '—';
  const n = Number(percent);
  if (!Number.isFinite(n)) return '—';
  return `${String(Number(n.toFixed(1)))}%`;
}

/**
 * When a reading was taken, for display.
 *
 * The **time is shown only when there is one**: a reading recorded at midnight
 * UTC is what the Add reading dialog's date field submits (stage 2 reads a
 * date-only value as midnight), so printing `00:00` beside it would invent a
 * precision the member never entered. A reading carrying a real time shows it,
 * which is also what keeps §33's two readings on one date legible as two rows
 * rather than as the same row twice — decided per row, never by comparing one
 * row against its neighbour.
 */
export function formatReadingTimestamp(iso: string | null, locale: string): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const date = at.toLocaleDateString(locale, {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  const midnight = at.getUTCHours() === 0 && at.getUTCMinutes() === 0 && at.getUTCSeconds() === 0;
  if (midnight) return date;
  const time = at.toLocaleTimeString(locale, {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
  return `${date} · ${time}`;
}

/** The marker a history row carries, as the key the page resolves (§20/§29). */
export const READING_MARKER_KEYS = {
  initial: 'marker_initial',
  new_initial: 'marker_new_initial',
} as const;

export type ReadingMarker = keyof typeof READING_MARKER_KEYS;

export interface GoalReadingHistoryRow extends GoalReadingRow {
  /** `null` for an ordinary measurement. */
  marker: ReadingMarker | null;
}

/**
 * §19 — the reading history, **newest first**, each row carrying the marker it
 * reads under.
 *
 * Three things are the rule rather than the implementation.
 *
 * * The API answers **oldest first**, because that is the order §17's chart
 *   draws in; this reverses it rather than asking for a second ordering.
 * * The **first** boundary is `Initial` and every later one is `New initial
 *   reading` (§20/§29): they are different facts, and wording them alike would
 *   leave a member unable to tell where they started from where the baseline was
 *   moved.
 * * A history with **no flagged reading at all** marks its earliest row
 *   `Initial`, which is exactly what `activeInitialReadingOf()` answers for that
 *   case: a header reading `80 kg` over a list in which nothing says where the
 *   80 came from is the one way this display goes wrong.
 */
export function readingHistoryRows(readings: GoalReadingRow[]): GoalReadingHistoryRow[] {
  const chronological = [...readings].sort(
    (a, b) => timeOf(a) - timeOf(b) || a.id - b.id,
  );
  const boundaries = chronological.filter((r) => r.is_initial);
  const baselineId = boundaries.length > 0
    ? boundaries[0].id
    : (chronological.length > 0 ? chronological[0].id : null);

  const marked = chronological.map((reading) => ({
    ...reading,
    marker: markerFor(reading, baselineId),
  }));
  return marked.reverse();
}

function markerFor(reading: GoalReadingRow, baselineId: number | null): ReadingMarker | null {
  if (reading.id === baselineId) return 'initial';
  return reading.is_initial ? 'new_initial' : null;
}

function timeOf(reading: GoalReadingRow): number {
  if (!reading.recorded_at) return 0;
  const at = new Date(reading.recorded_at).getTime();
  return Number.isNaN(at) ? 0 : at;
}

/* ── The Add reading dialog ───────────────────────────────────────────────── */

/** What the dialog holds. The unit is the assignment's and is never a field (§3). */
export interface ReadingFormValues {
  value: string;
  recorded_at: string;
}

/** `DECIMAL(10,2)`'s ceiling, mirroring `READING_VALUE_MAX` on the API side. */
export const READING_VALUE_MAX = 99999999.99;

/**
 * §32 — the date defaults to today, as the `YYYY-MM-DD` an `<input type="date">`
 * takes. Taken in UTC, which is the day the server stores it under.
 */
export function todayInputValue(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function emptyReadingForm(now?: Date): ReadingFormValues {
  return { value: '', recorded_at: todayInputValue(now) };
}

/**
 * The client half of `normalizeReadingValue()` + `normalizeRecordedAt()` — the
 * same rules, answered as a **locale key** so the words stay the page's.
 *
 * The server remains the enforcement point; this only avoids a round trip to be
 * told so, and it refuses a **future** date for the server's own reason: §32
 * allows historical dates only, and a mistyped year would otherwise become the
 * "latest reading" (§10) for ever.
 */
export function readingFormError(
  form: ReadingFormValues,
  now: Date = new Date(),
): string | null {
  const raw = form.value.trim();
  if (raw === '') return 'error_reading_required';
  const value = Number(raw);
  if (!Number.isFinite(value)) return 'error_reading_number';
  if (value < 0) return 'error_reading_negative';
  if (value > READING_VALUE_MAX) return 'error_reading_max';
  if (!form.recorded_at) return 'error_reading_date_required';
  if (form.recorded_at > todayInputValue(now)) return 'error_reading_date_future';
  return null;
}

/**
 * What both writers are sent. `recorded_at` is a date, which stage 2 reads as
 * midnight UTC — and the kind of reading is the **route**, never a field in
 * here, so a client cannot re-baseline a goal by passing a flag through.
 */
export function toReadingPayload(form: ReadingFormValues) {
  return {
    value: Number(form.value.trim()),
    recorded_at: form.recorded_at || null,
  };
}

/* ── #1037 stage 4: the chart ─────────────────────────────────────────────── */

/**
 * §13–§17/§38 — the reading history as chart points, oldest first.
 *
 * The adapter is the admin's own, not the charting layer's: `@gymdesk/charts`
 * knows nothing about goals, so every label a point carries is written here, in
 * the staff member's locale and the assignment's own unit (§16). The `group` is
 * the server's `period` (§38), which is what makes §23's segmented line one
 * answer rather than one per app.
 *
 * A reading with no value or no timestamp is dropped rather than plotted at
 * zero: `0` is a measurement, and a point invented for a row that has none is
 * the fake reading §14 forbids.
 */
export function readingChartPoints(
  readings: GoalReadingRow[],
  unit: string | null,
  locale: string,
): ChartPoint[] {
  return [...readings]
    .sort((a, b) => timeOf(a) - timeOf(b) || a.id - b.id)
    .filter((reading) => reading.value !== null && reading.recorded_at !== null)
    .map((reading) => ({
      x: timeOf(reading),
      y: Number(reading.value),
      group: Number.isFinite(reading.period) ? Math.max(0, Math.trunc(reading.period)) : 0,
      label: formatReadingTimestamp(reading.recorded_at, locale),
      valueLabel: formatReadingValue(reading.value, unit),
    }));
}

/** A chart axis tick: the day, short, in the reader's own locale. */
export function readingAxisLabel(at: number, locale: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
