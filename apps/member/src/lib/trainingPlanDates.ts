// #1956 — a Training Plan supplies workouts only on the dates inside its own
// Start Date and End Date, inclusive. Pure: no React, no `t()`, no network.
// Dates are compared as YYYY-MM-DD strings (the API serialises a DATE column as
// an ISO string at UTC midnight, so only its first ten characters are the day),
// which keeps the boundary free of any timezone conversion. A missing bound is
// open-ended on that side.

export interface PlanDateRange { start_date?: string | null; end_date?: string | null }

function dayOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const day = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

export function planCoversDate(plan: PlanDateRange, date: string): boolean {
  const start = dayOf(plan.start_date);
  const end = dayOf(plan.end_date);
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

/** The plans that supply workouts on `date`. */
export function plansOnDate<T extends PlanDateRange>(plans: T[], date: string): T[] {
  return plans.filter((p) => planCoversDate(p, date));
}
