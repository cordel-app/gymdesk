import { Tx } from '../infra/db';

/**
 * #1325 PR 3a — the operational assignment an Active ProductSet projects.
 *
 * `user_memberships` is operational only (validity, access, eligibility,
 * coverage) and a ProductSet is the commercial truth. This is the **one writer**
 * of the assignment row — written when a version activates and never edited by
 * anything else. Since PR 3e-4a it writes no benefit, Promotion or service rows
 * of its own: those are the version's, and every reader takes them through the
 * assignment's latest linked version. It is a derived read model, not a second
 * owner:
 *
 *  - `next_billing_date` is left NULL, so the assignment-driven nightly pass
 *    (which selects `next_billing_date IS NOT NULL`) never charges a projected
 *    assignment; the persisted events of the ProductSet are what bill;
 *  - a new version of the **same plan** updates the row in place; a **different
 *    plan** closes the previous assignment and opens a new one (#956's rule, and
 *    what keeps Past Membership Plans meaning "plans the member had");
 *  - a **plan-less** version has no assignment at all, and a previous one is
 *    closed;
 *  - family coverage is copied from `product_set_members`.
 *
 * The projection is removed with the legacy commercial columns in the final
 * stage; nothing may start reading it as the commercial owner.
 */

interface SetRow {
  id: number;
  gym_id: string;
  owner_member_id: number;
  root_product_set_id: number;
  previous_product_set_id: number | null;
  membership_plan_id: number | null;
  starts_at: Date | string;
  ends_at: Date | string | null;
  user_membership_id: number | null;
  created_by_name: string | null;
  created_by_type: string | null;
  membership_fee_price: string | number | null;
  free_periods: number | null;
  paid_periods: number | null;
  bonus_periods: number | null;
  pay_beforehand_periods: number | null;
  auto_renew: number | null;
  personal_fee_benefit_action: string | null;
  personal_fee_benefit_value: string | number | null;
  cadence_interval: number | null;
  cadence_unit: string | null;
  discount_reason: string | null;
  discount_expires_at: Date | string | null;
}

const dateOnly = (v: unknown): string | null =>
  v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

async function closeAssignment(tx: Tx, gymId: string, id: number, endsAt: string) {
  const { rows: before } = await tx.query<{ status: string; member_id: number }>(
    `SELECT status, member_id FROM user_memberships
      WHERE id = ? AND gym_id = ? AND status IN ('active','paused','pending_payment','draft') FOR UPDATE`,
    [id, gymId]);
  if (!before[0]) return;
  await tx.query(
    `UPDATE user_memberships
        SET status = 'cancelled', closed_at = UTC_TIMESTAMP(),
            ends_at = LEAST(COALESCE(ends_at, ?), ?)
      WHERE id = ? AND gym_id = ?`,
    [endsAt, endsAt, id, gymId],
  );
  // A transition is an audit row (#1325 PR 3, A4), whichever path made it.
  const { recordStatusChange } = await import('./billing-events');
  await recordStatusChange(tx, {
    gymId, userMembershipId: id, memberId: Number(before[0].member_id),
    previousStatus: before[0].status, newStatus: 'cancelled', source: 'system', actorUserId: null,
  });
}

const SET_SELECT = `
  SELECT ps.id, ps.gym_id, ps.owner_member_id, ps.root_product_set_id, ps.previous_product_set_id,
         ps.membership_plan_id, ps.starts_at, ps.ends_at, ps.user_membership_id,
         ps.created_by_name, ps.created_by_type,
         snap.membership_fee_price, snap.free_periods, snap.paid_periods, snap.bonus_periods,
         snap.pay_beforehand_periods, snap.auto_renew,
         snap.personal_fee_benefit_action, snap.personal_fee_benefit_value,
         snap.discount_reason, snap.discount_expires_at,
         sch.cadence_interval, sch.cadence_unit
    FROM product_sets ps
    LEFT JOIN product_set_plan_snapshots snap ON snap.product_set_id = ps.id
    LEFT JOIN product_set_schedules sch ON sch.id = snap.schedule_id
   WHERE ps.id = ? AND ps.gym_id = ?`;

async function loadSet(tx: Tx, gymId: string, productSetId: number): Promise<SetRow | null> {
  const { rows } = await tx.query<SetRow>(SET_SELECT, [productSetId, gymId]);
  return rows[0] ?? null;
}

/** Projects the (just activated) version onto its operational assignment. */
export async function projectActiveProductSet(tx: Tx, gymId: string, productSetId: number): Promise<number | null> {
  const set = await loadSet(tx, gymId, productSetId);
  if (!set) return null;

  // The assignment of the version this one replaced, if any.
  let previousUmId: number | null = set.user_membership_id != null ? Number(set.user_membership_id) : null;
  let previousPlanId: number | null = null;
  if (previousUmId == null && set.previous_product_set_id != null) {
    const { rows: prev } = await tx.query<{ user_membership_id: number | null }>(
      'SELECT user_membership_id FROM product_sets WHERE id = ? AND gym_id = ?',
      [set.previous_product_set_id, gymId]);
    previousUmId = prev[0]?.user_membership_id != null ? Number(prev[0].user_membership_id) : null;
  }
  if (previousUmId != null) {
    const { rows: um } = await tx.query<{ membership_plan_id: number | null }>(
      'SELECT membership_plan_id FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE', [previousUmId, gymId]);
    previousPlanId = um[0]?.membership_plan_id != null ? Number(um[0].membership_plan_id) : null;
  }
  const startsAt = dateOnly(set.starts_at) as string;

  // A plan-less version has no assignment; a previous one is closed.
  if (set.membership_plan_id == null) {
    if (previousUmId != null) await closeAssignment(tx, gymId, previousUmId, startsAt);
    await tx.query('UPDATE product_sets SET user_membership_id = NULL WHERE id = ?', [productSetId]);
    return null;
  }

  let umId: number;
  if (previousUmId != null && previousPlanId === Number(set.membership_plan_id)) {
    // Same plan, new version: the row is updated in place. The commercial
    // configuration is the version's — the row carries none (migration 258).
    umId = previousUmId;
    await tx.query(
      `UPDATE user_memberships
          SET ends_at = ?, status = IF(status IN ('cancelled','expired'), status, 'active')
        WHERE id = ? AND gym_id = ?`,
      [dateOnly(set.ends_at), umId, gymId],
    );
  } else {
    if (previousUmId != null) await closeAssignment(tx, gymId, previousUmId, startsAt);
    const { insertId } = await tx.query(
      `INSERT INTO user_memberships
         (gym_id, member_id, membership_plan_id, starts_at, ends_at, status,
          created_by_name, created_by_type)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      [gymId, set.owner_member_id, set.membership_plan_id, startsAt, dateOnly(set.ends_at),
        set.created_by_name, set.created_by_type],
    );
    umId = Number(insertId);
  }


  await tx.query('UPDATE product_sets SET user_membership_id = ? WHERE id = ?', [umId, productSetId]);
  return umId;
}

/**
 * #1325 PR 3e — keeps the assignment row of a **Draft** (or Pending Payment)
 * version in step with it. The Admin's Draft assignment is created set-first and
 * every edit of it goes through the Draft writers; the commercial columns and the
 * assignment-keyed copies the readers still use are re-derived from the version
 * here, so the row is a cache of the version and never written by anything else.
 * Unlike `projectActiveProductSet()` it never closes, opens or re-statuses an
 * assignment: the Draft's row already exists and its status is the commit's.
 * The cadence is deliberately not copied: a Draft's Billing frequency is frozen
 * from its Plan at creation and cannot be edited, while the chain's schedule may
 * carry an earlier plan's cadence (a schedule keeps the chain's identity).
 */
export async function syncDraftAssignment(tx: Tx, gymId: string, productSetId: number): Promise<void> {
  const set = await loadSet(tx, gymId, productSetId);
  if (!set || set.user_membership_id == null) return;
  const umId = Number(set.user_membership_id);
  await tx.query(
    'UPDATE user_memberships SET starts_at = ?, ends_at = ? WHERE id = ? AND gym_id = ?',
    [dateOnly(set.starts_at), dateOnly(set.ends_at), umId, gymId],
  );
}
