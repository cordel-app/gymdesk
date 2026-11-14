import { db } from '../infra/db';
import { assignmentCoversMemberSql, entitlingAssignmentSql } from '../domain/planAssignments';
import { registerBookingAccessHook } from './bookings';
import { soleActiveCenterId } from '../infra/centerContext';
import {
  centerAllowed, isPlanCenterAccessMode, resolveCenterAccess, type PlanCenterAccessInput, type PlanCenterAccessMode,
} from '../domain/planCenterAccess';
import { describePlanAccess, type PlanAccessBeneficiary, type PlanAccessEntry } from '../domain/planAccessBenefit';

/**
 * Booking-time center validation: if the member's active Membership Plan has
 * `membership_plan_centers` rows, the booking's center must be one of them.
 *
 * Lived in `plan-allowances.ts` until #635 stage 4 retired Included Services
 * (migration 177). It was never part of that concept — a plan's centers are
 * where it may be used, not what it includes — so the check moved here
 * unchanged rather than disappearing with `plan_allowances`.
 */
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/**
 * The live plans that cover a Member (as owner or covered Member, #374/#2125)
 * and the Member's default center when a plan needs it. The one read behind
 * both the booking hook and #2422's effective-access display, so they cannot
 * disagree.
 */
export async function loadMemberCenterAccessInputs(
  tx: Queryable,
  gymId: string,
  memberId: string | number,
): Promise<{ plans: PlanCenterAccessInput[]; defaultCenterId: number | null }> {
  const { rows: memberships } = await tx.query(
    `SELECT DISTINCT pa.membership_plan_id, mp.center_access_mode, mp.online_access FROM plan_snapshots pa
     JOIN membership_plans mp ON mp.id = pa.membership_plan_id
     WHERE pa.gym_id = ? AND ${entitlingAssignmentSql('pa')}
       AND ${assignmentCoversMemberSql('pa')}`,
    [gymId, memberId],
  );
  if (memberships.length === 0) return { plans: [], defaultCenterId: null };

  const planIds = memberships.map((m: { membership_plan_id: number }) => m.membership_plan_id);
  const marks = planIds.map(() => '?').join(',');
  const { rows: centerRows } = await tx.query(
    `SELECT membership_plan_id, center_id FROM membership_plan_centers
      WHERE gym_id = ? AND membership_plan_id IN (${marks})`,
    [gymId, ...planIds],
  );
  const plans: PlanCenterAccessInput[] = memberships.map((m: { membership_plan_id: number; center_access_mode: string; online_access: number }) => ({
    online: Number(m.online_access) === 1,
    mode: (isPlanCenterAccessMode(m.center_access_mode) ? m.center_access_mode : 'specific_centers') as PlanCenterAccessMode,
    centerIds: centerRows
      .filter((r: { membership_plan_id: number }) => r.membership_plan_id === m.membership_plan_id)
      .map((r: { center_id: number }) => r.center_id),
  }));

  // The Member's default center, read only when a plan needs it — never an arbitrary center.
  const defaultCenterId = plans.some((p) => p.mode === 'member_default_center')
    ? await memberDefaultCenterId(tx, gymId, memberId) : null;
  return { plans, defaultCenterId };
}

/**
 * A Member's default center: their `is_default` row, else the gym's sole active center
 * when they hold no center at all, else none.
 */
export async function memberDefaultCenterId(
  tx: Queryable, gymId: string, memberId: string | number,
): Promise<number | null> {
  const { rows: def } = await tx.query(
    `SELECT center_id FROM member_centers
      WHERE gym_id = ? AND member_id = ? AND is_default = 1 AND deleted_at IS NULL LIMIT 1`,
    [gymId, memberId],
  );
  if (def.length > 0) return def[0].center_id;
  const { rows: any } = await tx.query(
    'SELECT 1 FROM member_centers WHERE gym_id = ? AND member_id = ? AND deleted_at IS NULL LIMIT 1',
    [gymId, memberId],
  );
  return any.length === 0 ? soleActiveCenterId(gymId) : null;
}

/**
 * #2802 — the access one Membership Plan grants each of an assignment's beneficiaries, for
 * the Assigned Plan card. Read from the plan's own access configuration (the booking gate's
 * source); nothing is stored and no access is decided here.
 */
export async function loadPlanAccessEntries(
  gymId: string,
  membershipPlanId: number | null,
  beneficiaries: { member_id: number; name: string | null }[],
): Promise<PlanAccessEntry[]> {
  if (membershipPlanId == null || beneficiaries.length === 0) return [];
  const { rows: planRows } = await db.query(
    'SELECT center_access_mode, online_access FROM membership_plans WHERE id = ? AND gym_id = ?',
    [membershipPlanId, gymId],
  );
  if (planRows.length === 0) return [];
  const mode = (isPlanCenterAccessMode(planRows[0].center_access_mode)
    ? planRows[0].center_access_mode : 'specific_centers') as PlanCenterAccessMode;
  const { rows: planCenters } = await db.query(
    'SELECT center_id FROM membership_plan_centers WHERE gym_id = ? AND membership_plan_id = ?',
    [gymId, membershipPlanId],
  );
  const plan: PlanCenterAccessInput = {
    mode, online: Number(planRows[0].online_access) === 1,
    centerIds: planCenters.map((r: { center_id: number }) => Number(r.center_id)),
  };
  const withDefaults: PlanAccessBeneficiary[] = [];
  for (const b of beneficiaries) {
    withDefaults.push({
      member_id: Number(b.member_id), name: b.name ?? null,
      defaultCenterId: mode === 'member_default_center' ? await memberDefaultCenterId(db, gymId, b.member_id) : null,
    });
  }
  const { rows: centers } = await db.query(
    "SELECT id, name FROM centers WHERE gym_id = ? AND deleted_at IS NULL AND status = 'active'", [gymId],
  );
  const names = new Map<number, string>(centers.map((c: { id: number; name: string }) => [Number(c.id), String(c.name)]));
  return describePlanAccess(plan, names, withDefaults);
}

export interface MemberEffectiveCenterAccess {
  /** Every physical center, current and future; no centers are listed. */
  all: boolean;
  online: boolean;
  /** Present when a plan grants "Only Member Default Center". `center` is null without a default. */
  default_center: { granted: true; center: { id: number; name: string } | null } | null;
  /** Union of the explicitly selected centers of Specific Centers plans. */
  specific_centers: { id: number; name: string }[];
}

/** #2422: what the Member can actually access, derived on every read. */
export async function memberEffectiveCenterAccess(
  gymId: string,
  memberId: string | number,
): Promise<MemberEffectiveCenterAccess> {
  const { plans, defaultCenterId } = await loadMemberCenterAccessInputs(db, gymId, memberId);
  const access = resolveCenterAccess(plans, defaultCenterId);
  if (access.all) return { all: true, online: access.online, default_center: null, specific_centers: [] };

  const lookup = async (ids: number[]) => {
    if (ids.length === 0) return [] as { id: number; name: string }[];
    const { rows } = await db.query(
      `SELECT id, name FROM centers WHERE gym_id = ? AND deleted_at IS NULL AND status = 'active'
        AND id IN (${ids.map(() => '?').join(',')}) ORDER BY name`,
      [gymId, ...ids],
    );
    return rows as { id: number; name: string }[];
  };
  const specificIds = [...new Set(
    plans.filter((p) => p.mode === 'specific_centers').flatMap((p) => p.centerIds.map(Number)),
  )];
  let defaultCenter: { id: number; name: string } | null = null;
  const hasDefaultMode = plans.some((p) => p.mode === 'member_default_center');
  if (hasDefaultMode && defaultCenterId != null) defaultCenter = (await lookup([Number(defaultCenterId)]))[0] ?? null;
  return {
    all: false,
    online: access.online,
    default_center: hasDefaultMode ? { granted: true, center: defaultCenter } : null,
    specific_centers: await lookup(specificIds),
  };
}

registerBookingAccessHook(async (tx, gymId, memberId, _activityTypeId, centerId, opts) => {
  if (!centerId) return;
  // #481: staff override bypasses center coverage the same way `force` already
  // bypasses the capacity check.
  if (opts?.overrideAccess) return;

  const { plans, defaultCenterId } = await loadMemberCenterAccessInputs(tx, gymId, memberId);
  if (plans.length === 0) return; // No membership — other guards handle

  if (!centerAllowed(resolveCenterAccess(plans, defaultCenterId), centerId)) {
    throw Object.assign(
      new Error('Your membership plan does not cover this center.'),
      { status: 403, code: 'center_not_covered' },
    );
  }
});

/**
 * #2381: the centers a Member may pick as their Default Center — the same
 * coverage the booking hook above enforces, read for a form. A Member with no
 * active plan, or with a plan that lists no centers (covers every center), may
 * pick any active center of the gym; otherwise the union of the plans' centers.
 */
export async function centersAvailableToMember(
  gymId: string,
  memberId: string | number,
): Promise<{ id: number; name: string }[]> {
  const { rows: memberships } = await db.query<{ membership_plan_id: number }>(
    `SELECT DISTINCT pa.membership_plan_id FROM plan_snapshots pa
     WHERE pa.gym_id = ? AND ${entitlingAssignmentSql('pa')}
       AND (pa.member_id = ? OR ${assignmentCoversMemberSql('pa')})`,
    [gymId, memberId, memberId],
  );
  const planIds = memberships.map((m) => m.membership_plan_id);
  if (planIds.length > 0) {
    const marks = planIds.map(() => '?').join(',');
    const { rows: restricted } = await db.query(
      `SELECT DISTINCT mp.id FROM membership_plans mp
        WHERE mp.gym_id = ? AND mp.id IN (${marks})
          AND (EXISTS (SELECT 1 FROM membership_plan_centers mpc
                        WHERE mpc.membership_plan_id = mp.id AND mpc.gym_id = mp.gym_id)
               OR mp.center_access_mode = 'online'
               OR (mp.center_access_mode = 'specific_centers' AND mp.online_access = 1))`,
      [gymId, ...planIds],
    );
    if (restricted.length === planIds.length) {
      const { rows } = await db.query<{ id: number; name: string }>(
        `SELECT DISTINCT c.id, c.name FROM centers c
          JOIN membership_plan_centers mpc ON mpc.center_id = c.id AND mpc.gym_id = c.gym_id
         WHERE c.gym_id = ? AND c.deleted_at IS NULL AND c.status = 'active'
           AND mpc.membership_plan_id IN (${marks})
         ORDER BY c.name`,
        [gymId, ...planIds],
      );
      return rows;
    }
  }
  const { rows } = await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM centers WHERE gym_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY name`,
    [gymId],
  );
  return rows;
}
