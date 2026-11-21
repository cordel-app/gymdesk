/**
 * #3090 stage 4 (§5): how many sessions per week a member's Membership Plans include for a
 * Professional Service. The Professional Services Schedule compares the weekly slots staff
 * select against it and warns (never blocks) when they exceed it.
 *
 * Pure. A Session Benefit line renews with its own Frequency (#918); only a renewing one is
 * a per-week allowance. `once` and an unset Frequency are a one-time grant, so they say
 * nothing about a week and are left out: a service whose only lines are one-time (or that
 * the member holds through a purchased package alone) has no weekly allowance (`null`) and
 * is never warned about.
 */

/** Weeks in one renewal period of a renewing Session Benefit Frequency. */
const WEEKS_PER_PERIOD: Record<string, number> = {
  week: 1,
  four_weeks: 4,
  month: 52 / 12,
  year: 52,
};

export interface AllowanceLine {
  professional_service_id: number;
  quantity: number;
  frequency: string | null;
}

/** Sessions per week one line includes, or `null` when the line does not renew. */
export function weeklyAllowanceOfLine(quantity: number, frequency: string | null): number | null {
  const weeks = frequency == null ? undefined : WEEKS_PER_PERIOD[frequency];
  if (weeks === undefined || !Number.isFinite(quantity) || quantity < 0) return null;
  return quantity / weeks;
}

/**
 * Sessions per week included per Professional Service, rounded to two decimals. A service
 * with no renewing line is absent from the map.
 */
export function weeklyAllowanceByService(lines: AllowanceLine[]): Map<number, number> {
  const totals = new Map<number, number>();
  for (const line of lines) {
    const perWeek = weeklyAllowanceOfLine(line.quantity, line.frequency);
    if (perWeek === null) continue;
    totals.set(line.professional_service_id, (totals.get(line.professional_service_id) ?? 0) + perWeek);
  }
  for (const [id, total] of totals) totals.set(id, Math.round(total * 100) / 100);
  return totals;
}
