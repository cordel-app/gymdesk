// #1370 stage 2 — the decisions behind My Training's week navigation and
// progress rings. Pure: no React, no `t()`, no network. Dates are plain
// `YYYY-MM-DD` strings; the gym's "today" comes from the API, never from here.

/** Days from Monday (0) to Sunday (6), the order the selector shows. */
export const WEEK_OFFSETS = [0, 1, 2, 3, 4, 5, 6] as const;

const MS_DAY = 86_400_000;

function toUtc(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * MS_DAY);
}

/** 0=Sunday … 6=Saturday, the numbering `workouts.scheduled_weekday` uses. */
export function weekdayOf(date: string): number {
  return new Date(toUtc(date)).getUTCDay();
}

/** Position in the Monday-first selector: Monday 0 … Sunday 6. */
export function mondayIndex(date: string): number {
  return (weekdayOf(date) + 6) % 7;
}

export function weekStart(date: string): string {
  return addDays(date, -mondayIndex(date));
}

/** The seven dates of the week containing `date`, Monday first. */
export function weekDates(date: string): string[] {
  const start = weekStart(date);
  return WEEK_OFFSETS.map((i) => addDays(start, i));
}

/** Moving a week keeps the weekday: Tuesday stays Tuesday. */
export function shiftWeek(date: string, weeks: number): string {
  return addDays(date, weeks * 7);
}

export function isFutureDate(date: string, today: string): boolean {
  return date > today;
}

/** Swipe left (finger moves left) goes to the next week, right to the previous. */
export type SwipeResult = -1 | 0 | 1;

const SWIPE_MIN_PX = 50;
const SWIPE_DOMINANCE = 1.5;

/**
 * A week change needs a mostly-horizontal gesture of a minimum length, so an
 * ordinary vertical scroll (or a diagonal drag) never navigates.
 */
export function swipeWeekDelta(dx: number, dy: number): SwipeResult {
  if (Math.abs(dx) < SWIPE_MIN_PX) return 0;
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_DOMINANCE) return 0;
  return dx < 0 ? 1 : -1;
}

export interface RingGeometry { radius: number; circumference: number; dashOffset: number; percent: number }

/** The progress ring: 0 total is an empty ring, the visual value is clamped to 0–100. */
export function ringGeometry(percent: number, radius: number): RingGeometry {
  const p = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const circumference = 2 * Math.PI * radius;
  return { radius, circumference, dashOffset: circumference * (1 - p / 100), percent: Math.round(p) };
}

export interface ProgressCounts { completed: number; total: number; percent: number }
export interface TrainingProgress { day: ProgressCounts; week: ProgressCounts; month: ProgressCounts; today?: string }

export const EMPTY_PROGRESS: TrainingProgress = {
  day: { completed: 0, total: 0, percent: 0 },
  week: { completed: 0, total: 0, percent: 0 },
  month: { completed: 0, total: 0, percent: 0 },
};

/** The device's date, only used until the API has told us the gym's today. */
export function deviceToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
