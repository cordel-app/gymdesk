/**
 * #1367: the Home dashboard's pure rules — date windows in the gym's time zone
 * and which sections a role may see. No DB, no HTTP.
 *
 * Every window is computed here once and handed to SQL as UTC instants, so no
 * DATETIME crosses a time-zone conversion inside a query (the convention the
 * reminder and cancellation windows already follow).
 */
import { DateTime } from 'luxon';
import { canAccess, type AppModule, type AppRole } from '../infra/permissions';
import { DEFAULT_GYM_LOCALIZATION, isValidTimeZone } from './gymLocalization';

export interface UtcWindow {
  /** Inclusive lower bound, `YYYY-MM-DD HH:mm:ss` UTC. */
  from: string;
  /** Exclusive upper bound, `YYYY-MM-DD HH:mm:ss` UTC. */
  to: string;
}

const SQL_FORMAT = 'yyyy-LL-dd HH:mm:ss';

export function resolveTimeZone(zone: unknown): string {
  return isValidTimeZone(zone) ? zone : DEFAULT_GYM_LOCALIZATION.time_zone;
}

/** `YYYY-MM-DD` strictly; anything else (including 2026-02-31) is not a date. */
export function parseDashboardDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const dt = DateTime.fromISO(value, { zone: 'utc' });
  return dt.isValid && dt.toISODate() === value ? value : null;
}

/** Today's calendar date in the gym's zone. */
export function todayInZone(zone: string, now: DateTime = DateTime.utc()): string {
  return now.setZone(zone).toISODate()!;
}

function toWindow(start: DateTime, end: DateTime): UtcWindow {
  return {
    from: start.toUTC().toFormat(SQL_FORMAT),
    to: end.toUTC().toFormat(SQL_FORMAT),
  };
}

/** The gym-local calendar day `date`, as a UTC window. */
export function dayWindow(date: string, zone: string): UtcWindow {
  const start = DateTime.fromISO(date, { zone }).startOf('day');
  return toWindow(start, start.plus({ days: 1 }));
}

/**
 * The gym-local week containing `date`. `firstDayOfWeek` uses the project's
 * weekday base (0 = Sunday … 6 = Saturday), like `gyms.first_day_of_week`.
 */
export function weekWindow(date: string, zone: string, firstDayOfWeek: number): UtcWindow {
  const day = DateTime.fromISO(date, { zone }).startOf('day');
  const dow = day.weekday % 7; // luxon 1..7 (Mon..Sun) → 0..6 (Sun..Sat)
  const offset = (dow - (((firstDayOfWeek % 7) + 7) % 7) + 7) % 7;
  const start = day.minus({ days: offset });
  return toWindow(start, start.plus({ days: 7 }));
}

/** The current instant as a SQL UTC string. */
export function nowSql(now: DateTime = DateTime.utc()): string {
  return now.toUTC().toFormat(SQL_FORMAT);
}

export type HomeSection = 'members' | 'classes' | 'payments';

const SECTION_MODULE: Record<HomeSection, AppModule> = {
  members: 'MEMBERS',
  classes: 'CALENDAR',
  payments: 'PAYMENTS',
};

/**
 * Which parts of Home a role may read. A section is a data source, so it needs
 * the same module access its own management screen does — a Front Desk user
 * sees payments, an Accountant sees no member data, and so on.
 */
export function homeAccess(role: AppRole, isSuperadmin: boolean): Record<HomeSection, boolean> {
  const out = {} as Record<HomeSection, boolean>;
  for (const section of Object.keys(SECTION_MODULE) as HomeSection[]) {
    out[section] = isSuperadmin || canAccess(role, SECTION_MODULE[section]);
  }
  return out;
}

export type HomeTaskKey =
  | 'events_without_space'
  | 'events_without_trainer'
  | 'welcome_new_members'
  | 'services_not_scheduled'
  | 'events_with_waitlist'
  | 'payments_with_issues';

export interface HomeTask {
  key: HomeTaskKey;
  count: number;
  /** Secondary figure (waiting-list people for E). */
  secondary?: number;
  /** Up to a few names, for the member tasks. */
  samples?: { id: number; name: string; detail?: string | null }[];
}

/** A task is shown only when something is outstanding. */
export function visibleTasks(tasks: HomeTask[]): HomeTask[] {
  return tasks.filter((t) => t.count > 0);
}
