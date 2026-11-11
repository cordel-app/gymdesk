// #2607 — the "One per Member" Product restriction, enforced server-side.
//
// A Product flagged `one_per_member` may be held once by a member. "Held" is
// read from the assignment's own state rather than from payments: a one-time
// purchase that is pending payment or active (and neither cancelled nor past
// its validity), or a recurring line still running on one of the member's
// Product Sets. `draftSetId` narrows the recurring half to that Draft's own
// lines, because a line the Draft already removed must not block adding it back.

import type { Tx } from '../infra/db';
import { assignmentPlanSnapshotId } from './assignment-config';
import { PLAN_LINE_TABLE } from './plan-snapshot-lines';
import { MEMBER_PURCHASE_SNAPSHOTS_SQL, memberPurchaseSnapshotParams } from './purchase-snapshots';

type Queryable = Pick<Tx, 'query'>;

export async function productIsOnePerMember(q: Queryable, gymId: string, productId: number): Promise<boolean> {
  const { rows } = await q.query<any>(
    'SELECT one_per_member FROM products WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [productId, gymId],
  );
  return Boolean(rows[0]?.one_per_member);
}

/** Assignment statuses under which a Membership Plan's Products are the member's (stage 2). */
const PLAN_HOLDING_STATUSES = ['active', 'paused', 'pending_payment'] as const;

/** The included-Product lines of every plan snapshot, as one derived table (`plan_snapshot_id`, `product_id`). */
const PLAN_LINES_SQL = Object.values(PLAN_LINE_TABLE)
  .map((t) => `SELECT plan_snapshot_id, product_id FROM ${t}`).join(' UNION ALL ');

/**
 * #2607 stage 2 — the member holds the Product through a Membership Plan: a live assignment
 * (active, paused or awaiting payment, not past its `ends_at`) whose current plan snapshot carries
 * the Product as an included line and names the member among its beneficiaries. A payer who is not
 * a beneficiary (#2125 stage 22) does not hold it. `excludeUserMembershipIds` leaves out the
 * assignments named — the one being committed, so a plan never conflicts with itself, and the
 * plans a Replace is about to supersede.
 */
export async function memberHoldsProductThroughPlan(
  q: Queryable, gymId: string, memberId: number, productId: number, excludeUserMembershipIds: readonly number[] = [],
): Promise<boolean> {
  const marks = PLAN_HOLDING_STATUSES.map(() => '?').join(',');
  const excluded = excludeUserMembershipIds.length > 0 ? excludeUserMembershipIds : [0];
  const excludedMarks = excluded.map(() => '?').join(',');
  const { rows } = await q.query<any>(
    `SELECT um.id
       FROM user_memberships um
       JOIN plan_snapshots s ON s.id = ${assignmentPlanSnapshotId('um.id', 'um.gym_id')}
       JOIN plan_snapshot_beneficiaries b ON b.plan_snapshot_id = s.id AND b.member_id = ?
       JOIN (${PLAN_LINES_SQL}) l ON l.plan_snapshot_id = s.id AND l.product_id = ?
      WHERE um.gym_id = ? AND um.status IN (${marks}) AND um.id NOT IN (${excludedMarks})
        AND (um.ends_at IS NULL OR um.ends_at >= UTC_DATE())
      LIMIT 1`,
    [memberId, productId, gymId, ...PLAN_HOLDING_STATUSES, ...excluded],
  );
  return rows.length > 0;
}

export async function memberHoldsProduct(
  q: Queryable, gymId: string, memberId: number, productId: number,
  opts: { draftSetId?: number; excludeUserMembershipIds?: readonly number[] } = {},
): Promise<boolean> {
  const { rows: purchases } = await q.query<any>(
    // #2126 stage 3d: the purchases are read from the Product snapshot tables.
    `SELECT id FROM ${MEMBER_PURCHASE_SNAPSHOTS_SQL} mp
      WHERE product_id = ?
        AND status IN ('pending_payment', 'active') AND cancelled_on IS NULL
        AND (valid_until IS NULL OR valid_until >= UTC_DATE())
      LIMIT 1`,
    [...memberPurchaseSnapshotParams(gymId, memberId), productId],
  );
  if (purchases.length > 0) return true;
  // #2126 stage 3h: the recurring lines are read from `product_periodical_snapshots`,
  // kept equal to each version's lines by stage 2's dual-write
  // (`syncProductSnapshotsOfVersion()`, run by every Draft writer's `touch()`); the
  // check runs before the line it guards is written, so every line it reads is synced.
  const { rows: lines } = opts.draftSetId != null
    ? await q.query<any>(
      `SELECT source_id AS id FROM product_periodical_snapshots
        WHERE gym_id = ? AND product_set_id = ? AND product_id = ? AND source_id IS NOT NULL
          AND (ends_at IS NULL OR ends_at >= UTC_DATE())
        LIMIT 1`,
      [gymId, opts.draftSetId, productId],
    )
    : await q.query<any>(
      `SELECT r.source_id AS id FROM product_periodical_snapshots r
         JOIN product_sets ps ON ps.id = r.product_set_id AND ps.gym_id = r.gym_id
        WHERE r.gym_id = ? AND ps.owner_member_id = ? AND r.product_id = ? AND r.source_id IS NOT NULL
          AND ps.status IN ('draft', 'pending_payment', 'active')
          AND (r.ends_at IS NULL OR r.ends_at >= UTC_DATE())
        LIMIT 1`,
      [gymId, memberId, productId],
    );
  if (lines.length > 0) return true;
  return memberHoldsProductThroughPlan(q, gymId, memberId, productId, opts.excludeUserMembershipIds);
}

/** True when the Product is `one_per_member` and the member already holds it. */
export async function violatesOnePerMember(
  q: Queryable, gymId: string, memberId: number, productId: number,
  opts: { draftSetId?: number; excludeUserMembershipIds?: readonly number[] } = {},
): Promise<boolean> {
  if (!(await productIsOnePerMember(q, gymId, productId))) return false;
  return memberHoldsProduct(q, gymId, memberId, productId, opts);
}

export const ONE_PER_MEMBER_MESSAGE = 'A member can only have one assignment of this product';

export interface PlanOnePerMemberConflict { member_id: number; product_id: number; product_name: string }

/**
 * #2607 stage 2 — the One per Member Products the assignment's own plan would give a beneficiary
 * who already holds them (a purchase, a recurring line or another live plan). Asked before a Draft
 * plan becomes the member's (Save & Pay, or a direct activation), never after a payment.
 */
export async function planOnePerMemberConflicts(
  q: Queryable, gymId: string, userMembershipId: number, replacedUserMembershipIds: readonly number[] = [],
): Promise<PlanOnePerMemberConflict[]> {
  const { rows } = await q.query<any>(
    `SELECT DISTINCT b.member_id, p.id AS product_id, p.name AS product_name
       FROM user_memberships um
       JOIN plan_snapshots s ON s.id = ${assignmentPlanSnapshotId('um.id', 'um.gym_id')}
       JOIN plan_snapshot_beneficiaries b ON b.plan_snapshot_id = s.id
       JOIN (${PLAN_LINES_SQL}) l ON l.plan_snapshot_id = s.id
       JOIN products p ON p.id = l.product_id AND p.gym_id = um.gym_id
      WHERE um.id = ? AND um.gym_id = ? AND p.one_per_member = 1
      ORDER BY b.member_id, p.id`,
    [userMembershipId, gymId],
  );
  const conflicts: PlanOnePerMemberConflict[] = [];
  for (const r of rows) {
    const memberId = Number(r.member_id); const productId = Number(r.product_id);
    if (await memberHoldsProduct(q, gymId, memberId, productId, { excludeUserMembershipIds: [userMembershipId, ...replacedUserMembershipIds] })) {
      conflicts.push({ member_id: memberId, product_id: productId, product_name: String(r.product_name) });
    }
  }
  return conflicts;
}

/** Throws a `409` naming the Products when the assignment's plan would break One per Member. */
export async function assertPlanOnePerMember(
  q: Queryable, gymId: string, userMembershipId: number, replacedUserMembershipIds: readonly number[] = [],
): Promise<void> {
  const conflicts = await planOnePerMemberConflicts(q, gymId, userMembershipId, replacedUserMembershipIds);
  if (conflicts.length === 0) return;
  const names = [...new Set(conflicts.map((c) => c.product_name))].join(', ');
  throw Object.assign(new Error(`${ONE_PER_MEMBER_MESSAGE}: ${names}`), { status: 409, code: 'one_per_member', conflicts });
}
