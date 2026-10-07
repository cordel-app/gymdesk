import { CANCELLATION_NOTICE_HOURS } from './bookingCancellation';
import type { ProfessionalServiceGrantKind, ProfessionalServiceGrantRow } from './memberProfessionalServices';

/**
 * #1189 stage 3 (#973 `Q2`): when a Professional Service session is spent, and
 * which grant pays for it. Pure — the SQL half is `api/service-consumption.ts`.
 *
 * Booking never spends. A session is spent by exactly one of three things, and
 * a booking spends at most once (`psc_one_per_booking`, migration 238):
 *
 *   - `attendance` — staff marked the member present;
 *   - `no_show`    — staff marked the member absent (automatic; staff may
 *                    answer "return class" instead, which spends nothing);
 *   - `late_cancel` — the booking was cancelled inside the notice window.
 *
 * The notice window is #1162's `CANCELLATION_NOTICE_HOURS`, deliberately the
 * same constant and not a second configuration, so the two rules cannot drift.
 */

export const CONSUMPTION_REASONS = ['attendance', 'late_cancel', 'no_show'] as const;
export type ConsumptionReason = (typeof CONSUMPTION_REASONS)[number];

/**
 * Plan-included sessions are spent before purchased ones (the thread's
 * proposal, confirmed on #1189): a purchase should outlast what the plan
 * gives for free. Within a kind the lowest reference id goes first, a stable
 * order that keeps a repeated run on the same grant.
 */
export const SPEND_ORDER: readonly ProfessionalServiceGrantKind[] = [
  'plan_session',
  'promotion_session',
  'membership_service',
  'class_package',
];

/** Is a cancellation `secondsUntilStart` before the event inside the notice window? */
export function isLateCancellation(secondsUntilStart: number): boolean {
  return secondsUntilStart < CANCELLATION_NOTICE_HOURS * 3600;
}

/** The ledger reason an attendance mark spends under. */
export function reasonForAttendance(status: 'present' | 'absent'): ConsumptionReason {
  return status === 'present' ? 'attendance' : 'no_show';
}

export interface ConsumedTotal {
  source_kind: ProfessionalServiceGrantKind;
  source_reference_id: number;
  consumed: number;
}

/**
 * Subtract the unreturned ledger rows from the grants that have no counter of
 * their own. A `class_package` row already reports its live
 * `sessions_remaining` (the writer decrements it), so it is left alone.
 */
export function applyConsumption(
  rows: ProfessionalServiceGrantRow[],
  consumed: ConsumedTotal[],
): ProfessionalServiceGrantRow[] {
  const spent = new Map<string, number>();
  for (const c of consumed) {
    spent.set(`${c.source_kind}:${c.source_reference_id}`, Number(c.consumed));
  }
  return rows.map((row) => {
    if (row.kind === 'class_package') return row;
    const used = spent.get(`${row.kind}:${row.reference_id}`) ?? 0;
    return used > 0 ? { ...row, sessions: Number(row.sessions) - used } : row;
  });
}

/**
 * The grant a session is spent from: among the member's rows for the services
 * the occurrence requires and with something left, the first by `SPEND_ORDER`
 * then reference id. `null` when nothing is left to spend — an attendance mark
 * on a member with no balance spends nothing rather than going negative.
 */
export function chooseSpendGrant(
  rows: ProfessionalServiceGrantRow[],
  requiredServiceIds: number[],
): ProfessionalServiceGrantRow | null {
  const wanted = new Set(requiredServiceIds);
  const candidates = rows
    .filter((r) => wanted.has(r.professional_service_id) && Number(r.sessions) > 0)
    .sort((a, b) => {
      const rank = SPEND_ORDER.indexOf(a.kind) - SPEND_ORDER.indexOf(b.kind);
      return rank !== 0 ? rank : a.reference_id - b.reference_id;
    });
  return candidates[0] ?? null;
}
