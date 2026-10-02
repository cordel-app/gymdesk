// #924 stage 3 — the Assigned Plan card's **Membership Fee Simulation**: the
// database half of `domain/assignmentExampleTimeline.ts`.
//
// It reads one assignment's pricing row and its standing Promotion
// applications and hands them to the shared projection. Every rule it applies
// is one of `membership-fee-pricing.ts`'s own — the fee context
// (`membershipFeeContextFor()`), the lapse of a negotiated fee
// (`negotiatedFeeLapsed()`) and the regular fee each benefit discounts from
// (`regularMembershipFee()`) — so the table beside the Pricing section cannot
// quote a cycle the nightly run prices differently (#635 stage 12).

import {
  FeeAssignmentRow,
  loadFeeAssignment,
  membershipFeeContextFor,
  negotiatedFeeLapsed,
} from './membership-fee-pricing';
import { loadPromotionApplicationsFor, regularMembershipFee } from './user-memberships';
import { toPlanDurationCadence } from '../domain/planDuration';
import type { PlanDurationCadence } from '../domain/planDuration';
import { computeAssignmentExampleTimeline } from '../domain/assignmentExampleTimeline';
import type { ExampleTimelineResult } from '../domain/exampleTimeline';

function toDateOnly(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

/**
 * The assignment's billing cadence as the timeline needs it: the frozen pair,
 * then its Plan's live one (`ASSIGNMENT_CADENCE`, already resolved into the
 * row), or `null` when it has neither. Unlike `toPlanDurationCadence()` this
 * does **not** fall back to `1 month`: a monthly table for an assignment with
 * no billing frequency would name dates nothing will ever charge on.
 */
function timelineCadence(row: FeeAssignmentRow): PlanDurationCadence | null {
  if (row.duration_cadence_interval == null || row.duration_cadence_unit == null) return null;
  const cadence = toPlanDurationCadence(row.duration_cadence_interval, row.duration_cadence_unit);
  return Number(row.duration_cadence_interval) >= 1 ? cadence : null;
}

/** The Membership Fee Simulation of one assignment. */
export async function assignedPlanFeeTimeline(
  gymId: string, row: FeeAssignmentRow,
): Promise<ExampleTimelineResult> {
  const applications = (await loadPromotionApplicationsFor(gymId, [row.id])).get(row.id) ?? [];
  const startsAt = toDateOnly(row.starts_at);

  // Both numbers the contract can be priced from, resolved once: the frozen
  // (possibly negotiated) fee, and — only when a negotiated fee carries an
  // expiry — what the Plan's price window says after it lapses. Which one a
  // period uses is `negotiatedFeeLapsed()`'s answer, the same predicate
  // `priceMembershipFeeOn()` asks per cycle.
  const negotiatedLapses = row.discount_reason != null && String(row.discount_reason).trim() !== ''
    && row.discount_expires_at != null;
  const frozen = (await regularMembershipFee(gymId, row, startsAt)) ?? null;
  const afterLapse = negotiatedLapses
    ? ((await regularMembershipFee(gymId, row, startsAt, { ignoreFrozenFee: true })) ?? null)
    : frozen;

  return computeAssignmentExampleTimeline({
    context: membershipFeeContextFor(row, applications),
    cadence: timelineCadence(row),
    regularFeeOn: (date) => (negotiatedFeeLapsed(row, date) ? afterLapse : frozen),
  });
}

/** The same, for a caller that has only the assignment's id. `null` if it is not this gym's. */
export async function assignedPlanFeeTimelineById(
  gymId: string, umId: number,
): Promise<ExampleTimelineResult | null> {
  const row = await loadFeeAssignment(gymId, umId);
  return row ? assignedPlanFeeTimeline(gymId, row) : null;
}
