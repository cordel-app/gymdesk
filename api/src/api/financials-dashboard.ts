/**
 * #638: Finance → Dashboard.
 *
 * Read-only aggregation over the Financials domain. Nothing here writes, and no
 * Membership Plan / Assigned Plan behaviour changes — the endpoints only count
 * what the other routers already own.
 *
 * Mounted under the Financials group feature flag (not `financials.plans`), so
 * the Dashboard keeps working for a gym that has the Plans page turned off.
 */
import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { isCurrentAssignmentSnapshotSql } from '../domain/planAssignments';

export const financialsDashboardRouter = Router();

export interface MembershipPlanCard {
  id: number;
  name: string;
  /** draft | active | paused | inactive (membership_plans.lifecycle_status) */
  lifecycle_status: string;
  assigned_members: number;
}

// An Assigned Plan counts towards its Plan's card while it is still in force or
// yet to start — i.e. every stored status except the two terminal ones, minus
// rows whose end date has already passed. That is exactly the set of rows the
// Assigned Plans list (#410's `lifecycle_status` projection in
// user-memberships.ts) shows as anything other than `cancelled` / `expired`, so
// the two screens agree on what "assigned" means.
//
// Assignments belonging to a soft-deleted Member are excluded: the Member is
// gone from every other screen, so counting them here would overstate the card.
//
// #1108 stage 1: so is a `draft` one. The card counts the Plans a gym has
// *assigned*, and a Draft is a purchase nobody has committed — it bills nothing
// and the member does not hold it — so counting it would overstate the card in
// exactly the way a cancelled assignment would. The list is spelled out rather
// than left as "not cancelled and not expired" for that reason.
//
// #2125 M6b-8: an assignment is its current plan snapshot (`domain/planAssignments.ts`), so each
// assignment still counts once however many Product Sets link a snapshot of it.
const ASSIGNED_JOIN = `
  LEFT JOIN plan_snapshots pa
         ON pa.membership_plan_id = p.id
        AND pa.gym_id = p.gym_id
        AND pa.status NOT IN ('draft', 'pending_payment', 'active_cancel_at_period_end', 'cancelled', 'expired', 'superseded')
        AND NOT (pa.status = 'active' AND pa.ends_at IS NOT NULL AND pa.ends_at < CURDATE())
        AND ${isCurrentAssignmentSnapshotSql('pa')}
        AND EXISTS (
              SELECT 1 FROM members m
               WHERE m.id = pa.member_id AND m.deleted_at IS NULL
            )
`;

/**
 * GET /financials/dashboard/membership-plans
 *
 * One card per Membership Plan: every active plan, plus non-active plans that
 * still have at least one assignment (a retired plan members are still on).
 * Non-active plans with no assignments are left out entirely.
 *
 * Each assignment counts once, so a Member holding two Assigned Plans of the
 * same Membership Plan counts twice — the card counts assignments, which is
 * what the Assigned Plans data actually records.
 */
financialsDashboardRouter.get('/membership-plans', async (req, res) => {
  const { gymId } = getTenantContext(req);

  const { rows } = await db.query<MembershipPlanCard & { assigned_members: number | string }>(
    `SELECT p.id,
            p.name,
            p.lifecycle_status,
            COUNT(pa.id) AS assigned_members
       FROM membership_plans p
       ${ASSIGNED_JOIN}
      WHERE p.gym_id = ? AND p.deleted_at IS NULL
      GROUP BY p.id, p.name, p.lifecycle_status
     HAVING p.lifecycle_status = 'active' OR COUNT(pa.id) > 0
      ORDER BY p.name ASC`,
    [gymId],
  );

  res.json(rows.map((r) => ({
    id: r.id,
    name: r.name,
    lifecycle_status: r.lifecycle_status,
    assigned_members: Number(r.assigned_members),
  })));
});
