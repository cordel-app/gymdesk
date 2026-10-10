// #1036 — **My Goals**: everything the member's goals page decides, with no JSX.
//
// The same split every Members App screen takes: the page renders, this module
// decides. What a goal is called, what its target reads as, which goals are
// still being pursued, what a form submits and which of its fields is wrong are
// all answered here, so the page holds markup and state and nothing else — and
// so all of it is unit-testable without a browser (there is no component-test
// infra in this app; see `my-nutrition-sections.test.ts`).
//
// It decides **no colour and no spacing**: those are `lib/memberChrome.ts`'s
// (#983), and a value spelled here would be the second place the Members App
// paints from.

import type { ChartPoint } from '@gymdesk/charts';

/**
 * The seeded System Personal Goals (`api/src/domain/goalLibrary.ts`'s
 * `SYSTEM_PERSONAL_GOALS`). A System row's label is its **slug** resolved
 * through `goals.goal_<slug>`, with the row's own `name` as the fallback — the
 * CLAUDE.md rule for a fixed seeded catalogue, and the same resolution the
 * admin's `goalDisplayName()` applies, so a member and the staff who assigned
 * their goal read the same words.
 *
 * A gym's own goal carries **no** slug and is shown under the single name its
 * staff typed, in whatever language they typed it.
 */
export const SYSTEM_PERSONAL_GOAL_SLUGS = [
  'weight_loss', 'weight_gain', 'muscle_gain', 'maintenance',
  'performance', 'recovery', 'energy',
] as const;

/**
 * One row of `GET /me/personal-goals` — an assignment, never a catalogue row.
 *
 * It **extends** the reading summary (#1037): the five header fields of §5 are
 * derived on every read by `api/src/api/goal-readings.ts` and ride on the row, so
 * the card has them without a second request and cannot compute one itself.
 */
export interface MemberGoal extends GoalReadingSummaryFields {
  id: number;
  personal_goal_id: number;
  /** The **snapshot** taken when it was assigned (§8), not the catalogue's current name. */
  goal_name: string;
  goal_slug: string | null;
  target_value: number | null;
  target_unit: string | null;
  /** #1229 — a `relative` target is a change from the baseline reading. */
  target_type?: 'absolute' | 'relative';
  start_date: string | null;
  target_date: string | null;
  /** When it stopped being pursued — removed, achieved or abandoned. */
  end_date: string | null;
  status: 'in_progress' | 'achieved' | 'abandoned';
  notes: string | null;
  deleted_at: string | null;
}

/** One row of `GET /me/personal-goals/available` — a Gym Goal the member may still add. */
export interface AssignableGoal {
  id: number;
  slug: string | null;
  name: string;
  description: string | null;
  target_value: number | null;
  target_unit: string | null;
}

/**
 * The label a goal is shown under.
 *
 * The fallback is decided **before** `t()` is called: next-intl has no
 * `defaultValue` option and prints a missing key verbatim, so asking it for
 * `goals.goal_<slug>` on a gym's own goal would put the key on screen
 * (CLAUDE.md, and the defect #812 reports).
 */
export function goalDisplayName(
  goal: { slug?: string | null; goal_slug?: string | null; name?: string; goal_name?: string },
  t: (key: string) => string,
): string {
  const slug = goal.goal_slug ?? goal.slug ?? null;
  const name = goal.goal_name ?? goal.name ?? '';
  const known = slug !== null && (SYSTEM_PERSONAL_GOAL_SLUGS as readonly string[]).includes(slug);
  return known ? t(`goals.goal_${slug}`) : name;
}

/**
 * `3 kg`, `70 kg`, `0 kg` — and `null` for a goal that has no target at all,
 * which the page renders as nothing rather than as `0` or `—`.
 *
 * A value of **zero is a target**, not an absence: Maintenance is seeded at
 * `0 kg` precisely because a change of zero is what the goal means (#1034 §2),
 * so the check is `=== null` and never falsiness. Trailing zeros are trimmed
 * (`3.00` → `3`) because the column is a DECIMAL(10,2) and `3.00 kg` is not how
 * anyone writes it.
 */
export function formatGoalTarget(goal: { target_value: number | null; target_unit: string | null }): string | null {
  if (goal.target_value === null || goal.target_value === undefined) return null;
  const value = Number(goal.target_value);
  if (!Number.isFinite(value)) return null;
  const text = String(Number(value.toFixed(2)));
  return goal.target_unit ? `${text} ${goal.target_unit}` : text;
}

/**
 * Whether the member is still pursuing this goal. The predicate
 * `mpgoal_live_goal_key` generates its unique key from, mirrored here so the
 * page's two lists split exactly where the server's do.
 */
export function isLiveGoal(goal: Pick<MemberGoal, 'deleted_at' | 'status'>): boolean {
  return goal.deleted_at === null && goal.status === 'in_progress';
}

/** The form behind `Add goal` and `Edit`, as the page holds it. */
export interface GoalFormValues {
  personal_goal_id: string;
  target_value: string;
  target_unit: string;
  start_date: string;
  target_date: string;
  notes: string;
}

export const emptyGoalForm: GoalFormValues = {
  personal_goal_id: '', target_value: '', target_unit: '', start_date: '', target_date: '', notes: '',
};

/**
 * #1115 §2 — the draft an inline `Add personal goal` card opens with: today's
 * date in **Start date**, and nothing else filled in.
 *
 * The date is the form's rather than the server's because it is a field the
 * member may still change before saving (§2's "must still be able to modify
 * it"), and it is `todayInputValue()`'s UTC day — the same one the Add reading
 * dialog defaults to, so the two cannot disagree about what today is.
 */
export function newGoalForm(now?: Date): GoalFormValues {
  return { ...emptyGoalForm, start_date: todayInputValue(now) };
}

/**
 * §5 — picking a Gym Goal pre-fills the target it carries, which is what makes
 * the form's `Target` and `Unit` fields show `3` and `Kg` the moment
 * `Lose weight` is chosen. A goal with no target of its own pre-fills nothing
 * rather than zero.
 *
 * It is applied **over the draft the member is already filling in** (#1115 §2),
 * not over an empty form: the inline card opens with today's Start date, and a
 * picker that reset the form would wipe that — and the notes and dates typed
 * before the goal was chosen with it.
 */
export function formForAssignableGoal(
  goal: AssignableGoal,
  current: GoalFormValues = emptyGoalForm,
): GoalFormValues {
  return {
    ...current,
    personal_goal_id: String(goal.id),
    target_value: goal.target_value === null || goal.target_value === undefined ? '' : String(goal.target_value),
    target_unit: goal.target_unit ?? '',
  };
}

/** Editing starts from what the member already agreed, never from the catalogue (§8). */
export function formForMemberGoal(goal: MemberGoal): GoalFormValues {
  return {
    personal_goal_id: String(goal.personal_goal_id),
    target_value: goal.target_value === null ? '' : String(goal.target_value),
    target_unit: goal.target_unit ?? '',
    start_date: goal.start_date ?? '',
    target_date: goal.target_date ?? '',
    notes: goal.notes ?? '',
  };
}

/** `DECIMAL(10,2)`'s ceiling, mirroring `TARGET_VALUE_MAX` on the API side. */
export const TARGET_VALUE_MAX = 99999999.99;
/** `VARCHAR(20)`, mirroring `TARGET_UNIT_MAX_LENGTH`. */
export const TARGET_UNIT_MAX_LENGTH = 20;
/** `VARCHAR(1000)`, mirroring `NOTES_MAX_LENGTH`. */
export const NOTES_MAX_LENGTH = 1000;

/**
 * What is wrong with the form, as a **locale key** rather than a sentence: the
 * page resolves it, so this module translates nothing and both halves stay
 * assertable (the rule `calendarEventDisplay.ts` already follows).
 *
 * It is deliberately the client half of the server's rules and not a second set
 * of them — a target date before the start date is what `chk_mpgoal_dates`
 * refuses. The server still checks it; this only avoids a round trip to be told
 * so.
 *
 * It does **not** refuse a unit with no value, although
 * `chk_mpgoal_target_unit` does: since #1115 §1 the unit is **read-only** and is
 * the Gym Goal's own, so a member who clears the target has not made a mistake
 * they could correct — `toGoalUpdatePayload()` drops the unit with the value it
 * qualified instead, and the row that reaches the database still satisfies the
 * CHECK. Refusing it here would leave the card unsavable with no editable field
 * to fix.
 */
export function goalFormError(values: GoalFormValues, { requireGoal }: { requireGoal: boolean }): string | null {
  if (requireGoal && !values.personal_goal_id) return 'goals.error_goal_required';

  const rawValue = values.target_value.trim();
  if (rawValue !== '') {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return 'goals.error_target_number';
    if (value < 0) return 'goals.error_target_negative';
    if (value > TARGET_VALUE_MAX) return 'goals.error_target_max';
  }
  const unit = values.target_unit.trim();
  if (unit !== '' && unit.length > TARGET_UNIT_MAX_LENGTH) return 'goals.error_unit_length';
  if (values.start_date && values.target_date && values.target_date < values.start_date) {
    return 'goals.error_dates';
  }
  if (values.notes.trim().length > NOTES_MAX_LENGTH) return 'goals.error_notes_length';
  return null;
}

/**
 * What `POST /me/personal-goals` is sent.
 *
 * An empty field is sent as an explicit `null` rather than omitted, because the
 * two mean different things to the API: omitting `target_value` **inherits the
 * Gym Goal's** (§8's snapshot, which the server takes), while `null` is the
 * member deliberately clearing it. The card pre-fills from the catalogue and
 * then submits exactly what is on screen, so what it sends is what the member
 * saw — a field they emptied stays empty instead of coming back filled.
 */
export function toGoalCreatePayload(values: GoalFormValues) {
  return {
    personal_goal_id: Number(values.personal_goal_id),
    ...toGoalUpdatePayload(values),
  };
}

/**
 * What `PUT /me/personal-goals/:id` is sent. `personal_goal_id` is **not** in
 * it: the assignment's goal is immutable, and changing it is a remove plus an
 * add (§12).
 *
 * The unit **follows the value** (#1115 §1): it is read-only and belongs to the
 * Gym Goal, so a target the member cleared takes its unit with it rather than
 * leaving a unit qualifying nothing — which is exactly what
 * `chk_mpgoal_target_unit` refuses, and which the member has no field to fix.
 */
export function toGoalUpdatePayload(values: GoalFormValues) {
  const rawValue = values.target_value.trim();
  const unit = values.target_unit.trim();
  const notes = values.notes.trim();
  return {
    target_value: rawValue === '' ? null : Number(rawValue),
    target_unit: rawValue === '' || unit === '' ? null : unit,
    start_date: values.start_date || null,
    target_date: values.target_date || null,
    notes: notes === '' ? null : notes,
  };
}

/**
 * Which of the four words a goal's pill reads, as a locale key.
 *
 * `removed` is the fourth and is **not** a stored status: a goal the member
 * removed keeps the progress it had (migration 212 keeps the two axes apart),
 * so the row says `in_progress` with a `deleted_at` beside it and reading the
 * column alone would label a removed goal *In progress* in the Past Goals
 * list. Deciding it here is what keeps the page from re-deriving it.
 */
export function goalStatusKey(goal: Pick<MemberGoal, 'deleted_at' | 'status'>): string {
  if (isLiveGoal(goal)) return 'goals.status_in_progress';
  if (goal.deleted_at !== null && goal.status === 'in_progress') return 'goals.status_removed';
  return `goals.status_${goal.status}`;
}

/**
 * The status word the app's own `statusTone()` is asked about, so a Past Goal's
 * pill takes one of the four tones every other Members App status takes (#983)
 * instead of a fifth map: an achieved goal reads as a success, an abandoned one
 * as cancelled, and a goal the member simply removed carries no judgement.
 */
export function goalStatusToneKey(goal: Pick<MemberGoal, 'deleted_at' | 'status'>): string {
  if (goal.status === 'achieved') return 'completed';
  if (goal.status === 'abandoned') return 'cancelled';
  return 'removed';
}

/* ── #1037 stage 3: readings ──────────────────────────────────────────────────
 * What a **reading** is on the member's side: the five header fields §5 lists,
 * how a value, a percentage and a timestamp are written, which history rows
 * carry the `Initial` marker, and what the Add reading dialog submits.
 *
 * It **computes nothing it could read**. `initial_reading`, `latest_reading` and
 * `progress_percent` ride on every row of `GET /me/personal-goals` (stage 2),
 * derived by `api/src/domain/goalReadings.ts` — the one place that decides a
 * percentage, which is what keeps My Goals, the Member card and the gym-wide
 * list from reporting one goal's progress three ways. Everything here is
 * formatting, ordering and validation.
 *
 * The admin has its own copy in
 * `apps/admin/src/components/personalGoals/goalReadings.ts`, because the two
 * apps share no frontend module — the rule `calendarEventDisplay.ts` and
 * `calendarEventPaint.ts` already follow. */

/** §5 — the five fields of the card header, in order, as locale keys. */
export const GOAL_HEADER_FIELDS = [
  'goals.field_goal',
  'goals.label_initial_reading',
  'goals.field_target',
  'goals.label_latest_reading',
  'goals.label_progress',
] as const;

/** The six computed fields every assignment-shaped read reports. */
export interface GoalReadingSummaryFields {
  /** §8 — the **currently active** initial reading, not necessarily the first. */
  initial_reading: number | null;
  initial_reading_at: string | null;
  /** §10 — the most recent reading, whatever period it falls in. */
  latest_reading: number | null;
  latest_reading_at: string | null;
  /** #1229 — what progress is measured against (absolute target, or baseline + relative change). */
  effective_target: number | null;
  /** §11 — 0..100, or `null` when it cannot be computed. */
  progress_percent: number | null;
  reading_count: number;
}

/** One row of `GET /me/personal-goals/:id/readings`. */
export interface GoalReading {
  id: number;
  value: number | null;
  /** ISO 8601 UTC — the one format the API reports every instant in. */
  recorded_at: string | null;
  /** §21 — whether this reading opens an initial-reading period. */
  is_initial: boolean;
  /** §38 — which period it falls in, 0-based. Read by the chart. */
  period: number;
}

export interface GoalReadingsResponse extends GoalReadingSummaryFields {
  readings: GoalReading[];
}

/** The two writers the API exposes, as the path each appends to the goal. */
export const READING_ENDPOINTS = { reading: 'readings', initial: 'initial-reading' } as const;

/** Which of the two the dialog is open for. Two actions, never a flag. */
export type ReadingKind = keyof typeof READING_ENDPOINTS;

/**
 * A reading as one phrase — `75 kg`, `75` with no unit, and `null` for none at
 * all, which the page renders as `—`.
 *
 * `0` is a measurement and not an absence, exactly as `formatGoalTarget()`
 * reasons about a Maintenance target of zero, so the check is `=== null`.
 */
export function formatReadingValue(
  value: number | null | undefined,
  unit: string | null,
): string | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const text = String(Number(n.toFixed(2)));
  return unit ? `${text} ${unit}` : text;
}

/**
 * §11/§27 — the progress figure, already clamped to 0..100 by the server.
 *
 * `null` means *not computable* (no readings, or no target) and reads as `—`
 * rather than `0%`: having made no progress and having recorded nothing are
 * different facts, and showing the second as the first tells a member they are
 * getting nowhere when nobody has measured them yet.
 *
 * Printed as it comes rather than rounded to a whole number — the server rounds
 * to one decimal, and rounding `99.9` up here would read `100%` on a goal that
 * is not finished.
 */
export function formatProgressPercent(percent: number | null | undefined): string | null {
  if (percent === null || percent === undefined) return null;
  const n = Number(percent);
  if (!Number.isFinite(n)) return null;
  return `${String(Number(n.toFixed(1)))}%`;
}

/**
 * When a reading was taken.
 *
 * The **time is shown only when there is one**: a reading recorded at midnight
 * UTC is what the dialog's date field submits (the API reads a date-only value
 * as midnight), so printing `00:00` beside it would invent a precision the
 * member never entered — while a reading carrying a real time shows it, which is
 * what keeps §33's two readings on one date legible as two rows. Decided per
 * row, never by comparing one row against its neighbour.
 */
export function formatReadingDate(iso: string | null, locale: string): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const date = at.toLocaleDateString(locale, {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  const midnight = at.getUTCHours() === 0 && at.getUTCMinutes() === 0 && at.getUTCSeconds() === 0;
  if (midnight) return date;
  return `${date} · ${at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}`;
}

/** The marker a history row reads under (§20/§29), as a locale key. */
export const READING_MARKER_KEYS = {
  initial: 'goals.marker_initial',
  new_initial: 'goals.marker_new_initial',
} as const;

export type ReadingMarker = keyof typeof READING_MARKER_KEYS;

export interface GoalReadingHistoryRow extends GoalReading {
  marker: ReadingMarker | null;
}

/**
 * §19 — the history, **newest first**, each row carrying its marker.
 *
 * Three things are the rule rather than the implementation. The API answers
 * oldest-first because that is the order §17's chart draws in, so this reverses
 * it rather than asking for a second ordering. The **first** boundary is
 * `Initial` and every later one is `New initial reading` (§20/§29) — different
 * facts, and wording them alike would leave a member unable to tell where they
 * started from where the baseline moved. And a history with **no** flagged
 * reading marks its earliest row `Initial`, which is exactly what the server's
 * `activeInitialReadingOf()` answers for that case: a header reading `80 kg`
 * over a list in which nothing says where the 80 came from is the one way this
 * display goes wrong.
 */
export function readingHistoryRows(readings: GoalReading[]): GoalReadingHistoryRow[] {
  const chronological = [...readings].sort((a, b) => readingTime(a) - readingTime(b) || a.id - b.id);
  const boundaries = chronological.filter((r) => r.is_initial);
  const baselineId = boundaries.length > 0
    ? boundaries[0].id
    : (chronological.length > 0 ? chronological[0].id : null);
  return chronological
    .map((reading) => ({
      ...reading,
      marker: reading.id === baselineId ? 'initial' as const : (reading.is_initial ? 'new_initial' as const : null),
    }))
    .reverse();
}

function readingTime(reading: GoalReading): number {
  if (!reading.recorded_at) return 0;
  const at = new Date(reading.recorded_at).getTime();
  return Number.isNaN(at) ? 0 : at;
}

/** What the Add reading dialog holds. The unit is the goal's and is not a field (§3). */
export interface ReadingFormValues {
  value: string;
  recorded_at: string;
}

/** `DECIMAL(10,2)`'s ceiling, mirroring `READING_VALUE_MAX` on the API side. */
export const READING_VALUE_MAX = 99999999.99;

/** §32 — today, as the `YYYY-MM-DD` an `<input type="date">` takes, in UTC. */
export function todayInputValue(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function emptyReadingForm(now?: Date): ReadingFormValues {
  return { value: '', recorded_at: todayInputValue(now) };
}

/**
 * The client half of the server's own two validators, answered as a **locale
 * key** so the words stay the page's. A **future** date is refused for the
 * server's reason: §32 allows historical dates only, and a mistyped year would
 * otherwise be the "latest reading" (§10) for ever.
 */
export function readingFormError(form: ReadingFormValues, now: Date = new Date()): string | null {
  const raw = form.value.trim();
  if (raw === '') return 'goals.error_reading_required';
  const value = Number(raw);
  if (!Number.isFinite(value)) return 'goals.error_reading_number';
  if (value < 0) return 'goals.error_reading_negative';
  if (value > READING_VALUE_MAX) return 'goals.error_reading_max';
  if (!form.recorded_at) return 'goals.error_reading_date_required';
  if (form.recorded_at > todayInputValue(now)) return 'goals.error_reading_date_future';
  return null;
}

/**
 * What both writers are sent. The **kind** of reading is the route and never a
 * field in here, so nothing a member's browser submits can re-baseline a goal.
 */
export function toReadingPayload(form: ReadingFormValues) {
  return { value: Number(form.value.trim()), recorded_at: form.recorded_at || null };
}

/* ── #1037 stage 4: the chart ─────────────────────────────────────────────── */

/**
 * §13–§17/§38 — the reading history as chart points, oldest first.
 *
 * The adapter is the app's, not the charting layer's: `@gymdesk/charts` knows
 * nothing about goals, and every label a point carries is written here, in this
 * member's own locale and this goal's own unit (§16). What the layer does with
 * `group` is §23's segmented line — the period is the server's answer (§38), so
 * neither app decides where a period starts.
 *
 * A reading with no value is dropped rather than plotted: a point at `0` is a
 * measurement of zero, and inventing one would be the fake reading §14 forbids.
 */
export function readingChartPoints(
  readings: GoalReading[],
  unit: string | null,
  locale: string,
): ChartPoint[] {
  return [...readings]
    .sort((a, b) => readingTime(a) - readingTime(b) || a.id - b.id)
    .filter((reading) => reading.value !== null && reading.recorded_at !== null)
    .map((reading) => ({
      x: readingTime(reading),
      y: Number(reading.value),
      group: Number.isFinite(reading.period) ? Math.max(0, Math.trunc(reading.period)) : 0,
      label: formatReadingDate(reading.recorded_at, locale),
      valueLabel: formatReadingValue(reading.value, unit) ?? undefined,
    }));
}

/** A chart axis tick: the day, short, in the member's own locale. */
export function readingAxisLabel(at: number, locale: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/* ── #1115: the goal card ─────────────────────────────────────────────────────
 * The card's **header** (§1) is the goal's name, its target and how far along it
 * is — the one line a member reads with every card collapsed. The three values
 * are already the lib's (`goalDisplayName()`, `formatGoalTarget()`,
 * `formatProgressPercent()`); what is left is how they are joined, which is
 * decided here rather than in the page for `NutritionItemRow`'s reason: a
 * separator typed into a screen is a second place that words a goal. */

/**
 * The card header's second line, from the parts the page has already resolved
 * and translated — `Target: 70 kg · 65%`.
 *
 * A part that is absent is **left out rather than placeholdered**, and all parts
 * absent answers `null`, which the card renders as no line at all: a goal with
 * no target and no reading shows its name alone, never `Target: — · —%` or a
 * dangling separator (`calendarEventMeta.ts`'s rule, one screen over).
 */
export function goalSummaryLine(parts: (string | null | undefined)[]): string | null {
  const present = parts.filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  return present.length === 0 ? null : present.join(' · ');
}
