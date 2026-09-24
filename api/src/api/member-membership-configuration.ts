import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { fetchAppliedPromotions } from './membership-promotions';
import { loadServicesForAssignments } from './user-membership-services';
import { newMemberCutoff, qualifiesAsNewMember } from '../domain/newMemberEligibility';

/**
 * #634 (stage 3) — the Member's Membership configuration, read in one call.
 *
 * #634 §13 splits the Member → Membership experience into four independent
 * sections: MEMBERSHIP PLANS, PROMOTIONS, ADDITIONAL SERVICES and BILLING
 * SIMULATION. The simulation already has its own endpoint (#629,
 * billing-simulation.ts); this one feeds the other three.
 *
 * They are served together rather than as three endpoints because they are one
 * consistent picture of the same Member — the Promotions and Services sections
 * exist at Member level (never nested inside a Membership Plan card, §13), so
 * each row has to carry the Assigned Plan it belongs to, and fetching them per
 * plan from the browser would be an N+1 that could also tear: a plan added
 * between two requests would show with no promotions. Read-only end to end; it
 * writes nothing and persists nothing.
 *
 * Writes stay on the existing per-Assigned-Plan routes — POST
 * /user-memberships (add a plan), POST/DELETE /user-memberships/:id/promotions,
 * POST/DELETE /user-memberships/:id/services — so there is exactly one
 * enforcement point per rule and this module holds no business logic.
 */

// The statuses that still have billing ahead of them, and therefore the
// assignments whose Promotions and Services are part of the Member's *current*
// configuration. Deliberately the same list the Billing Simulation consolidates
// (SIMULATED_STATUSES in billing-simulation.ts), so the three configuration
// sections and the simulation below them can never disagree about which plans
// count.
const LIVE_STATUSES = ['draft', 'awaiting_payment', 'active', 'paused'] as const;

// mysql2 may return DATE columns as Date objects rather than strings depending
// on the connection's timezone config (same note as user-memberships.ts and
// user-membership-services.ts). Every date leaves this module as a plain
// YYYY-MM-DD string, matching the `services` rows, so one payload never mixes
// bare dates with full timestamps and the browser has no timezone to shift by.
function toDateOnly(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

// #635 stage 4: the Membership Plan card used to list the plan's Included
// Services (`plan_allowances`) here. The concept is retired (migration 177) —
// which activities a Member may book is now the Activity Type's own eligible-plan
// list, configured from the Activity Types page.

export const memberMembershipConfigurationRouter = Router({ mergeParams: true });

memberMembershipConfigurationRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const memberId = Number((req.params as any).memberId);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return res.status(400).json({ error: 'memberId must be a positive integer' });
  }

  const { rows: memberRows } = await db.query(
    'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [memberId, gymId],
  );
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  // Every assignment, newest first — the Member page has shown the full plan
  // history since #412 and #634 §14 does not retire it; `is_live` marks the
  // ones the Promotions/Services sections and the simulation act on.
  const { rows: plans } = await db.query(
    `SELECT um.id, um.membership_plan_id, um.status, um.final_price,
            um.starts_at, um.ends_at, um.next_billing_date,
            um.closed_at, um.created_at,
            p.name AS plan_name,
            um.status IN (${LIVE_STATUSES.map(() => '?').join(',')}) AS is_live
     FROM user_memberships um
     LEFT JOIN membership_plans p ON p.id = um.membership_plan_id
     WHERE um.gym_id = ? AND um.member_id = ?
     ORDER BY um.starts_at DESC, um.id DESC`,
    [...LIVE_STATUSES, gymId, memberId],
  );

  const livePlans = plans.filter((p: any) => Number(p.is_live) === 1);
  const planNameById = new Map<number, string | null>(livePlans.map((p: any) => [p.id, p.plan_name]));
  const liveIds = livePlans.map((p: any) => p.id as number);

  // fetchAppliedPromotions() is the same helper GET /user-memberships/:id and
  // GET /user-memberships/:id/promotions answer with, so a promotion reads
  // identically whichever surface lists it. One call per live assignment: a
  // Member has a handful of plans, not a page of them.
  const [promotionsPerPlan, services] = await Promise.all([
    Promise.all(liveIds.map((id) => fetchAppliedPromotions(gymId, id))),
    loadServicesForAssignments(gymId, liveIds),
  ]);

  const promotions = promotionsPerPlan.flatMap((rows, i) =>
    rows.map((row: any) => ({
      ...row,
      user_membership_id: liveIds[i],
      plan_name: planNameById.get(liveIds[i]) ?? null,
    })),
  );

  // #634 §3 — whether a Promotion flagged "Only applicable for new members"
  // would be accepted on each plan. It is a property of the *Member*, but it is
  // reported per Assigned Plan because the plan a Promotion is attached to
  // never counts against its own Member (see new-member-eligibility.ts) — so
  // the answer differs between a Member's first plan and their second. The
  // enforcement point stays POST /user-memberships/:id/promotions; this only
  // lets the PROMOTIONS section say why an option is unavailable instead of
  // offering it and surfacing a 400.
  const cutoff = newMemberCutoff(new Date());

  res.json({
    plans: plans.map((p: any) => ({
      id: p.id,
      membership_plan_id: p.membership_plan_id,
      plan_name: p.plan_name,
      status: p.status,
      final_price: p.final_price,
      starts_at: toDateOnly(p.starts_at),
      ends_at: toDateOnly(p.ends_at),
      next_billing_date: toDateOnly(p.next_billing_date),
      is_live: Number(p.is_live) === 1,
      new_member_eligible: qualifiesAsNewMember(plans as any, cutoff, Number(p.id)),
    })),
    promotions,
    services: services.map((s) => ({ ...s, plan_name: planNameById.get(s.user_membership_id) ?? null })),
  });
});
