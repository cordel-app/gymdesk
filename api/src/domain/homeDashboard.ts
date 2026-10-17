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

/** #1466: members listed under Home's pending-payments summary (most overdue first). */
export const PENDING_PAYMENT_MEMBER_LIMIT = 10;

export interface OutstandingEventRow {
  member_id: number | string | null;
  amount: number | string | null;
  created_at: Date | string;
}

export interface PendingPaymentGroup {
  member_id: number;
  outstanding_amount: number;
  oldest_at: string;
}

/**
 * One group per member from the outstanding Billing Events `isAwaitingAction()`
 * already selected: a member with several is counted once, their amounts are
 * summed, and the groups are ordered by their oldest outstanding event so the
 * most overdue member leads. Pure; the caller decides what an event is.
 */
export function groupPendingPaymentMembers(rows: OutstandingEventRow[]): PendingPaymentGroup[] {
  const byMember = new Map<number, { cents: number; oldest: number }>();
  for (const r of rows) {
    if (r.member_id == null) continue;
    const id = Number(r.member_id);
    const at = new Date(r.created_at).getTime();
    const cents = Math.round(Number(r.amount ?? 0) * 100);
    const g = byMember.get(id);
    if (g) { g.cents += cents; g.oldest = Math.min(g.oldest, at); }
    else byMember.set(id, { cents, oldest: at });
  }
  return [...byMember.entries()]
    .map(([member_id, g]) => ({
      member_id,
      outstanding_amount: g.cents / 100,
      oldest_at: new Date(g.oldest).toISOString(),
    }))
    .sort((a, b) => a.oldest_at.localeCompare(b.oldest_at) || a.member_id - b.member_id);
}

/** #1754: the four-week attendance KPIs look at this many complete weeks. */
export const FOUR_WEEKS = 4;

/**
 * The last `count` complete gym-local ISO weeks (Monday–Sunday) before the week
 * containing `today`, oldest first. ISO weeks rather than the gym's first day of
 * week: the KPI is defined as "each of the last four weeks", and a fixed week
 * boundary keeps it comparable between gyms.
 */
export function completedWeekWindows(today: string, zone: string, count: number = FOUR_WEEKS): UtcWindow[] {
  const thisMonday = DateTime.fromISO(today, { zone }).startOf('day').minus({ days: DateTime.fromISO(today, { zone }).weekday - 1 });
  const out: UtcWindow[] = [];
  for (let i = count; i >= 1; i--) {
    const start = thisMonday.minus({ weeks: i });
    out.push(toWindow(start, start.plus({ weeks: 1 })));
  }
  return out;
}

export interface AttendanceKpis {
  /** Members who attended at least one session in every one of the weeks. */
  top_trainers: number;
  /** Attended sessions per active member per week; 0 with no members. */
  average_classes_per_member_per_week: number;
  weeks: number;
}

/**
 * Pure: `at` is a `YYYY-MM-DD HH:mm:ss` UTC string of the attended session,
 * `weeks` the windows from `completedWeekWindows()`. An attendance outside every
 * window is ignored.
 */
export function attendanceKpis(
  attended: { member_id: number; at: string }[],
  weeks: UtcWindow[],
  activeMembers: number,
): AttendanceKpis {
  const perMember = new Map<number, Set<number>>();
  let total = 0;
  for (const a of attended) {
    const w = weeks.findIndex((x) => a.at >= x.from && a.at < x.to);
    if (w < 0) continue;
    total += 1;
    if (!perMember.has(a.member_id)) perMember.set(a.member_id, new Set());
    perMember.get(a.member_id)!.add(w);
  }
  const top = [...perMember.values()].filter((s) => s.size === weeks.length).length;
  const avg = activeMembers > 0 && weeks.length > 0 ? total / activeMembers / weeks.length : 0;
  return {
    top_trainers: weeks.length > 0 ? top : 0,
    average_classes_per_member_per_week: Math.round(avg * 100) / 100,
    weeks: weeks.length,
  };
}
