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
