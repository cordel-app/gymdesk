// #1538 — which version of the member's Membership Plan the section shows.
//
// Pure: it decides nothing about lifecycle (the server does) and only says which
// of the rows the configuration read returned are drawn. One version at a time:
// as soon as a Draft (or a Pending Payment version) of the plan exists it
// *replaces* the Active snapshot in the view — the snapshot is untouched
// server-side and returns when the Draft is cancelled — and the same version is
// never listed a second time as an "in progress" entry.

import type { MemberPlanRow, ProductSetRow } from './membershipConfiguration';

const IN_FLIGHT = new Set(['in_cart', 'pending_payment']);
/** The stored status of a plan cancelling at its period end (`api/src/domain/assignmentStatus.ts`). */
const CANCELS_AT_PERIOD_END = 'active_cancel_at_period_end';
/** #3114: the same plan, marked for reactivation in the open In Cart; it still runs to its end date. */
const PENDING_REACTIVATION = 'to_be_reactivated';

export const isInFlightPlan = (p: Pick<MemberPlanRow, 'status'>): boolean => IN_FLIGHT.has(p.status);

export interface VisiblePlans {
  /** The rows the first table draws: the in-flight version when there is one, else the live plans. */
  rows: MemberPlanRow[];
  /** `draft` when the rows are the replacement version, `active` otherwise (the heading follows it). */
  heading: 'active' | 'draft';
  /** The separate "in progress" list is redundant while a plan row is the in-flight version. */
  showInFlightList: boolean;
}

export function visiblePlans(plans: readonly MemberPlanRow[]): VisiblePlans {
  const live = plans.filter((p) => p.is_live);
  const inFlight = live.filter(isInFlightPlan);
  // #2659 stage 3: a plan cancelling at its period end is carried by the Draft (for entitlement
  // only — never billed), so it stays listed beside the in-flight version until its end date.
  // An Active plan is still replaced in the view by the Draft, as #1538 decides.
  const cancelling = plans.filter((p) => (p.status === CANCELS_AT_PERIOD_END || p.status === PENDING_REACTIVATION) && p.is_current && !isInFlightPlan(p));
  // #2742: a version awaiting its first payment is listed in the Active category (its own
  // `Pending Payment` badge tells it apart); only a Draft takes the view out of it.
  if (inFlight.length > 0) {
    const heading = inFlight.some((p) => p.status === 'in_cart') ? 'draft' : 'active';
    // #3119: an In Cart plan is listed beside the running plans, never instead of them. Only the
    // running plan an in-flight version re-freezes (same Membership Plan: the ⋮ → Edit Draft of
    // #1538) is replaced in the view; every other live plan keeps its row.
    const replacedPlanIds = new Set(inFlight.map((p) => p.membership_plan_id).filter((id) => id != null));
    const kept = plans.filter((p) => !isInFlightPlan(p)
      && (p.is_live || p.is_current)
      && !(p.is_live && p.membership_plan_id != null && replacedPlanIds.has(p.membership_plan_id)));
    const rows = plans.filter((p) => isInFlightPlan(p) && p.is_live || kept.includes(p));
    return { rows: rows.length ? rows : [...inFlight, ...cancelling], heading, showInFlightList: false };
  }
  // #2549: a cancelled plan stays in Active until its end date passes (status badge unchanged).
  return { rows: plans.filter((p) => p.is_live || p.is_current), heading: 'active', showInFlightList: true };
}

/**
 * #1538 stage 3 — whether `⋮ → Edit` is offered on a plan row. Only the Member's
 * own, running plan can start a replacement Draft: a Draft or a Pending Payment
 * version is already the in-flight version (it is configured in place), a plan
 * covered through someone else's Membership is read-only (#1191) and a plan with
 * no Membership Plan has nothing to re-freeze.
 */
export function canEditLivePlan(
  p: Pick<MemberPlanRow, 'status' | 'is_live' | 'assignment_relationship' | 'membership_plan_id'>,
): boolean {
  return p.is_live && !isInFlightPlan(p) && p.assignment_relationship !== 'linked' && p.membership_plan_id != null;
}

/**
 * #3114 — the reactivation item a plan row's `⋮` offers: `mark` on the Member's own plan that is
 * cancelling at its period end and still current (it is put in the open In Cart as
 * `to_be_reactivated`), `unmark` on one already marked, nothing otherwise. Such a plan is not live
 * (`is_live` is false for both statuses), so this answer must not sit behind the live plan's
 * lifecycle actions — it did, and the item was never shown. A Linked plan is read-only (#1191).
 */
export function planReactivationAction(
  p: Pick<MemberPlanRow, 'status' | 'assignment_relationship'> & { is_current?: boolean },
): 'mark' | 'unmark' | null {
  if (p.assignment_relationship === 'linked') return null;
  if (p.status === CANCELS_AT_PERIOD_END && p.is_current) return 'mark';
  if (p.status === PENDING_REACTIVATION) return 'unmark';
  return null;
}

/**
 * #2742 — the Membership Plans awaiting their first payment that no assignment row
 * represents yet: a plan a member chose in the Members App is a ProductSet version in
 * `pending_payment`, and its assignment is projected only when the payment activates it.
 * The Member card lists these in the Active category, labelled `Pending Payment`, from the
 * version's own stored status — nothing here changes or infers a lifecycle. A version
 * linked to an assignment (an Admin Save & Pay) is already one of the plan rows, so it is
 * never listed twice; a version with no plan has no Membership Plan to show.
 */
export function pendingPaymentPlanSets(productSets: readonly ProductSetRow[]): ProductSetRow[] {
  return productSets.filter((ps) => ps.status === 'pending_payment'
    && ps.user_membership_id == null
    && ps.membership_plan_id != null);
}

/**
 * #2966 stage 4 — the plans staff added to a member's in-flight cart as plan snapshots only. They
 * have no assignment row, so the Member card lists them from the version's own `added_plans`,
 * labelled with the version's stored status (a Draft reads `In Cart`).
 */
export function addedCartPlans(productSets: readonly ProductSetRow[]): Array<ProductSetRow & { id: number }> {
  return productSets.flatMap((ps) => (ps.status === 'in_cart' || ps.status === 'pending_payment' ? ps.added_plans ?? [] : [])
    .map((a) => ({
      id: ps.id * 1_000_000 + a.plan_snapshot_id,
      status: ps.status,
      plan_name: a.plan_name,
      membership_plan_id: a.membership_plan_id,
      starts_at: a.starts_at,
      amount_due: null,
      expired: ps.expired,
      created_by: ps.created_by,
      // #2966 stage 8: the Promotions applied to this added plan, as the API reported them.
      promotions: a.promotions ?? [],
    })));
}

/**
 * #2966 stage 8 — the names an added plan's Promotions are listed under on its row, in the order
 * they were applied. A Promotion whose catalogue row is gone has no name to show and is skipped.
 */
export function addedPlanPromotionNames(row: { promotions?: ReadonlyArray<{ promotion_name: string | null }> | null }): string[] {
  return (row.promotions ?? []).map((p) => p.promotion_name).filter((n): n is string => !!n && n.trim() !== '');
}

/**
 * #2966 stage 5 — an added plan's row id is `setId * 1_000_000 + planSnapshotId` (it has no
 * assignment id), so the staff remove route (`DELETE /product-sets/:setId/plans/:snapshotId`)
 * is addressed by taking that id apart. Only a Draft (`in_cart`) row may be removed.
 */
export function addedPlanRemovePath(row: { id: number; status?: string | null }): string | null {
  if (row.status !== 'in_cart') return null;
  const setId = Math.floor(row.id / 1_000_000);
  const snapshotId = row.id % 1_000_000;
  return setId > 0 && snapshotId > 0 ? `/product-sets/${setId}/plans/${snapshotId}` : null;
}

/**
 * #2966 stage 10 — which cart plan an added row's editor reads and writes, taken apart from the row
 * id as `addedPlanRemovePath()` does. Only a Draft (`in_cart`) row is edited; the server still judges
 * whether the plan takes an edit (`editable` on `GET /product-sets/:id/plans/:planSnapshotId`).
 */
export function addedPlanEditTarget(row: { id: number; status?: string | null }): { productSetId: number; planSnapshotId: number } | null {
  if (row.status !== 'in_cart') return null;
  const productSetId = Math.floor(row.id / 1_000_000);
  const planSnapshotId = row.id % 1_000_000;
  return productSetId > 0 && planSnapshotId > 0 ? { productSetId, planSnapshotId } : null;
}

const uniqueById = <T extends { id: number }>(rows: readonly T[]): T[] => {
  const seen = new Set<number>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
};

/**
 * #2887 / #3086 — the Past list and the count beside the heading are this one array, so
 * they cannot disagree, and a plan is listed once. Cancelled Product Sets are not a second
 * source: their summary header is not drawn above the table.
 *
 * A plan is past when its snapshot end date is before today (`is_past`) or when it is
 * neither live nor current — the assignment rows the table showed before `is_past`, including
 * a finished plan with no end date. Listing only `is_past` dropped that table and the section.
 */
export function pastPlans(plans: readonly MemberPlanRow[]): MemberPlanRow[] {
  return uniqueById(plans.filter((p) => p.is_past === true || (!p.is_live && !p.is_current)));
}
