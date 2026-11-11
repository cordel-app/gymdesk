import { Tx } from '../infra/db';
import { syncPlanSnapshot } from './plan-snapshot-sync';
import { primaryPlanSnapshotId } from './plan-snapshot-lines';
import { SYSTEM_ACTOR } from '../domain/auditActor';
import { supersedeApplications } from './one-active-plan';
import { cancellationStatusFor } from '../domain/assignmentStatus';

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
 *  - a new version that **changed** its plan opens its own assignment and closes
 *    the previous one (#1995 stage 2), so the predecessor and its Promotion
 *    applications stay as history; one that reuses the predecessor's plan
 *    unchanged — the same snapshot, linked (#2125 M4b-3) — keeps the
 *    predecessor's assignment, since the contract did not move;
 *  - a **plan-less** version has no assignment at all, and a previous one is
 *    closed;
 *  - coverage is each plan snapshot's own beneficiaries (#2125 stage 21).
 *
 * The projection is removed with the legacy commercial columns in the final
 * stage; nothing may start reading it as the commercial owner.
 */

interface SetRow {
  id: number;
  gym_id: string;
  owner_member_id: number;
  previous_product_set_id: number | null;
  membership_plan_id: number | null;
  starts_at: Date | string;
  ends_at: Date | string | null;
  user_membership_id: number | null;
  created_by: string | null;
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

async function closeAssignment(
  tx: Tx, gymId: string, id: number, endsAt: string, actor: string | null,
  /** `superseded` when a successor takes the plan over, `cancelled` when the member is left with none (#1991). */
  closedAs: 'cancelled' | 'superseded' = 'cancelled',
) {
  const { rows: before } = await tx.query<{ status: string; member_id: number; ends_at: Date | string | null }>(
    `SELECT status, member_id, ends_at FROM user_memberships
      WHERE id = ? AND gym_id = ? AND status IN ('active','paused','pending_payment','draft') FOR UPDATE`,
    [id, gymId]);
  if (!before[0]) return;
  // #2659 stage 2: a member's cancellation keeps the plan running to its last
  // paid day (`ends_at`) as `active_cancel_at_period_end` when that day is today
  // or later; the end-of-period sweep moves it to `cancelled` afterwards.
  const current = dateOnly(before[0].ends_at);
  const newEndsAt = current != null && current < endsAt ? current : endsAt;
  const status = closedAs === 'superseded'
    ? 'superseded'
    : cancellationStatusFor(newEndsAt, new Date().toISOString().slice(0, 10));
  await tx.query(
    `UPDATE user_memberships
        SET status = ?, closed_at = COALESCE(closed_at, UTC_TIMESTAMP()),
            ends_at = ?,
            modified_at = UTC_TIMESTAMP(), modified_by = ?
      WHERE id = ? AND gym_id = ?`,
    [status, newEndsAt, actor, id, gymId],
  );
  if (closedAs === 'superseded') await supersedeApplications(tx, gymId, id, actor);
  // A transition is an audit row (#1325 PR 3, A4), whichever path made it.
  const { recordStatusChange } = await import('./billing-events');
  await recordStatusChange(tx, {
    gymId, userMembershipId: id, memberId: Number(before[0].member_id),
    previousStatus: before[0].status, newStatus: status, source: 'system', actorUserId: null,
  });
}

const SET_SELECT = `
  SELECT ps.id, ps.gym_id, ps.owner_member_id, ps.previous_product_set_id,
         ps.membership_plan_id, ps.starts_at, ps.ends_at, ps.user_membership_id,
         ps.created_by,
         snap.membership_fee_price, snap.free_periods, snap.paid_periods, snap.bonus_periods,
         snap.pay_beforehand_periods, snap.auto_renew,
         snap.personal_fee_benefit_action, snap.personal_fee_benefit_value,
         snap.discount_reason, snap.discount_expires_at,
         sch.cadence_interval, sch.cadence_unit
    FROM product_sets ps
    LEFT JOIN product_set_plan_snapshots psj ON psj.product_set_id = ps.id AND psj.entitlement_only = 0
    LEFT JOIN plan_snapshots snap ON snap.id = psj.plan_snapshot_id
    LEFT JOIN product_set_schedules sch ON sch.id = snap.schedule_id
   WHERE ps.id = ? AND ps.gym_id = ?`;

async function loadSet(tx: Tx, gymId: string, productSetId: number): Promise<SetRow | null> {
  const { rows } = await tx.query<SetRow>(SET_SELECT, [productSetId, gymId]);
  return rows[0] ?? null;
}

/** Points a version's Membership Plan Promotion applications at its assignment. */
async function attachApplications(tx: Tx, gymId: string, productSetId: number, umId: number) {
  // A version that takes over an assignment in place (the Admin's set-first
  // edit) supersedes the applications of the version it replaces: they stay as
  // that version's history, keyed by it, and stop being the assignment's.
  await tx.query(
    `UPDATE user_membership_promotions
        SET user_membership_id = NULL
      WHERE gym_id = ? AND user_membership_id = ? AND product_set_id <> ?`,
    [gymId, umId, productSetId]);
  await tx.query(
    `UPDATE user_membership_promotions ump
       JOIN promotions pr ON pr.id = ump.promotion_id AND pr.applies_to = 'membership_plan'
        SET user_membership_id = ?
      WHERE ump.gym_id = ? AND ump.product_set_id = ?`,
    [umId, gymId, productSetId]);
}

/**
 * Whether the version's primary plan snapshot is the predecessor's own — linked by
 * `previous_product_set_id` too — and the contract of the predecessor's assignment.
 */
async function reusesPredecessorsContract(
  tx: Tx, gymId: string, set: SetRow, previousUmId: number,
): Promise<boolean> {
  if (set.previous_product_set_id == null) return false;
  const primary = await primaryPlanSnapshotId(tx, gymId, Number(set.id));
  if (primary == null) return false;
  const { rows } = await tx.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM plan_snapshots s
       JOIN product_set_plan_snapshots prev ON prev.plan_snapshot_id = s.id AND prev.product_set_id = ? AND prev.entitlement_only = 0
      WHERE s.id = ? AND s.gym_id = ? AND s.source_user_membership_id = ?`,
    [set.previous_product_set_id, primary, gymId, previousUmId]);
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Projects the (just activated) version onto its operational assignment. */
export async function projectActiveProductSet(
  tx: Tx, gymId: string, productSetId: number, actorArg?: string | null,
): Promise<number | null> {
  // #1182: who made the move. Left out means the system did (webhook, run).
  const actor = actorArg === undefined ? SYSTEM_ACTOR : actorArg;
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
    if (previousUmId != null) await closeAssignment(tx, gymId, previousUmId, startsAt, actor);
    await tx.query('UPDATE product_sets SET user_membership_id = NULL WHERE id = ?', [productSetId]);
    return null;
  }

  // The version's own Draft assignment (the Admin creates it set-first, PR 3e)
  // is activated in place: it is this version's row, not a predecessor's.
  // #2125 M4b-3: so is the predecessor's assignment when this version reuses its
  // plan **unchanged** — the primary plan snapshot is the predecessor's own (a
  // link, never a copy, since `cloneConfiguration()` links) and that snapshot is
  // the contract of the predecessor's assignment. Nothing about the plan moved,
  // so the assignment continues rather than being closed for a same-plan
  // successor; a plan the version edited was copied for it (`ownPlanSnapshot()`),
  // names no predecessor link, and opens its own assignment below as before.
  const continuedUmId = set.user_membership_id == null && previousUmId != null
    && await reusesPredecessorsContract(tx, gymId, set, previousUmId) ? previousUmId : null;
  if (set.user_membership_id != null || continuedUmId != null) {
    const umId = Number(set.user_membership_id ?? continuedUmId);
    await tx.query(
      `UPDATE user_memberships
          SET ends_at = ?, status = IF(status IN ('active_cancel_at_period_end','cancelled','expired','superseded'), status, 'active'),
              purchased_at = IF(status IN ('active_cancel_at_period_end','cancelled','expired','superseded'), purchased_at, COALESCE(purchased_at, UTC_TIMESTAMP())),
              modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE id = ? AND gym_id = ?`,
      [dateOnly(set.ends_at), actor, umId, gymId],
    );
    await attachApplications(tx, gymId, productSetId, umId);
    if (continuedUmId != null) await tx.query('UPDATE product_sets SET user_membership_id = ? WHERE id = ?', [umId, productSetId]);
    return umId;
  }

  // #1995 stage 2: every successor opens its own assignment — a same-plan one
  // included — and the predecessor stays behind as history with its own
  // Promotion applications. The predecessor is closed first, so the one-active
  // index is never held by two rows; this runs at activation (payment settled),
  // so a failed or abandoned payment never reaches it.
  if (previousUmId != null) {
    const { rows: prev } = await tx.query<{ starts_at: Date | string }>(
      'SELECT starts_at FROM user_memberships WHERE id = ? AND gym_id = ?', [previousUmId, gymId]);
    let endsAt = startsAt;
    if (previousPlanId === Number(set.membership_plan_id) && prev[0]) {
      // Same plan: both rows must not count as entitled on the same day.
      const day = new Date(`${startsAt}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() - 1);
      const dayBefore = day.toISOString().slice(0, 10);
      const prevStart = dateOnly(prev[0].starts_at) as string;
      endsAt = dayBefore < prevStart ? prevStart : dayBefore;
    }
    await closeAssignment(tx, gymId, previousUmId, endsAt, actor, 'superseded');
  }
  const { insertId } = await tx.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, starts_at, ends_at, status,
        purchased_at, created_by)
     VALUES (?, ?, ?, ?, ?, 'active', COALESCE((SELECT um0.purchased_at FROM user_memberships um0 WHERE um0.id = ? AND um0.gym_id = ?), UTC_TIMESTAMP()), ?)`,
    [gymId, set.owner_member_id, set.membership_plan_id, startsAt, dateOnly(set.ends_at),
      previousUmId, gymId, set.created_by],
  );
  const umId = Number(insertId);

  // The version's Membership Plan Promotion applications (and, through their
  // ids, the grant snapshots) belong to the assignment it projects.
  await attachApplications(tx, gymId, productSetId, umId);

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
export async function syncDraftAssignment(
  tx: Tx, gymId: string, productSetId: number, actor?: string | null,
): Promise<void> {
  const set = await loadSet(tx, gymId, productSetId);
  // #2125 stage 2: every Draft edit ends here, so the plan snapshot is re-derived here.
  await syncPlanSnapshot(tx, gymId, productSetId);
  if (!set || set.user_membership_id == null) return;
  const umId = Number(set.user_membership_id);
  // A caller that passes the actor is an edit of the Draft (recorded as the
  // row's modification); one that does not is re-deriving the cache of a row it
  // has just created, which is not a modification of anything.
  const touched = actor !== undefined;
  await tx.query(
    `UPDATE user_memberships
        SET starts_at = ?, ends_at = ?,
            modified_at = IF(?, UTC_TIMESTAMP(), modified_at), modified_by = IF(?, ?, modified_by)
      WHERE id = ? AND gym_id = ?`,
    [dateOnly(set.starts_at), dateOnly(set.ends_at), touched ? 1 : 0, touched ? 1 : 0, actor ?? null, umId, gymId],
  );
}
