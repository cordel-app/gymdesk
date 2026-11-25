/**
 * #3403 — the start and end date an Assigned Nutrition Plan or Assigned
 * Training Plan shows, in one place for both lists and both halves of a row.
 *
 * Assigned Membership Plans are the reference (`AssignedPlansTable`): a stored
 * end date reads as that date, no end date reads as *Open-ended*. Both plan
 * kinds store `end_date` only when the plan has ended (Complete, a superseding
 * plan, an expired Training Plan), so an active or draft plan reads
 * Open-ended; migration 487 gave every ended plan written before that its date.
 * The dates are calendar days, never moved across a time zone.
 */
import { formatGymDateOnly, type GymFormatSettings } from './gymFormat';

export type AssignedPlanEndDate = { kind: 'date'; value: string } | { kind: 'open_ended' };

export function assignedPlanEndDate(endDate: string | null | undefined): AssignedPlanEndDate {
  return endDate ? { kind: 'date', value: endDate } : { kind: 'open_ended' };
}

/** The two texts a row shows; `openEndedLabel` is the page's resolved locale value. */
export function assignedPlanDateTexts(
  plan: { start_date: string | null | undefined; end_date: string | null | undefined },
  settings: GymFormatSettings,
  openEndedLabel: string,
): { start: string; end: string } {
  const end = assignedPlanEndDate(plan.end_date);
  return {
    start: formatGymDateOnly(plan.start_date, settings),
    end: end.kind === 'date' ? formatGymDateOnly(end.value, settings) : openEndedLabel,
  };
}
