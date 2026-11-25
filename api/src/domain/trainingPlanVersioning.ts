import { DateTime } from 'luxon';

/**
 * #1969: versioning of assigned Training Plans. Pure — the I/O half is the
 * `edit-draft` / `publish-version` routes in api/src/api/training-plans.ts.
 *
 * A version's name is `<base name> [<start> - <end>]`, with the literal `Open End`
 * while it has no end date. The base name is derived by stripping that suffix, so
 * editing a plan more than once never accumulates suffixes.
 */

export const OPEN_END_LABEL = 'Open End';

const VERSION_SUFFIX_RE = /\s*\[\d{4}-\d{2}-\d{2} - (?:\d{4}-\d{2}-\d{2}|Open End)\]\s*$/;

export function baseTrainingPlanName(name: string): string {
  return name.replace(VERSION_SUFFIX_RE, '').trim();
}

export function versionedTrainingPlanName(name: string, start: string, end: string | null): string {
  return `${baseTrainingPlanName(name)} [${start} - ${end ?? OPEN_END_LABEL}]`;
}

/** The day after a YYYY-MM-DD date, in the same format. */
export function nextDay(date: string): string {
  return DateTime.fromISO(date, { zone: 'UTC' }).plus({ days: 1 }).toISODate() as string;
}

/** The day before a YYYY-MM-DD date, in the same format. */
export function previousDay(date: string): string {
  return DateTime.fromISO(date, { zone: 'UTC' }).minus({ days: 1 }).toISODate() as string;
}

/**
 * #3409: an Active plan whose start date is the gym's today is edited in place —
 * no version draft, no confirmation, nothing ended or renamed. Compares calendar
 * dates (YYYY-MM-DD) only, so a DATE column read as a string or as a UTC-midnight
 * `Date` (the pool's `timezone: 'Z'`) gives the same answer; `today` is the gym's
 * local day from `gymToday()`, never the database's or the server's.
 */
export function isSameDayEdit(startDate: string | Date | null | undefined, today: string): boolean {
  if (startDate == null || startDate === '') return false;
  const day = typeof startDate === 'string' ? startDate.slice(0, 10) : startDate.toISOString().slice(0, 10);
  return day === today;
}
