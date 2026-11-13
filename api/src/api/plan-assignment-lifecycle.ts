/**
 * #2125 M6b-2 — a lifecycle change reaches a plan snapshot more than one Product Set links by a copy,
 * never by a write in place.
 *
 * A plan a Product Set reuses unchanged is one snapshot shared with its predecessor (M4b-3), and the
 * sync never writes a shared snapshot. Until this stage that left the assignment's lifecycle on
 * `user_memberships` alone: a paused, resumed or cancelling plan kept reading `active` on its snapshot
 * (the `shared = 1` rows of `npm run plan-assignments:validate`). `plan_snapshots` is to become the
 * record of the assignment, so the change has to land on a snapshot, and Oscar's rule says which:
 *
 *   1. the snapshot is shared, so a new one is created for the Product Set being changed;
 *   2. it is the same logical assignment (same `assignment_id`, same `source_user_membership_id`);
 *   3. the previous snapshot and the Product Sets that link it are left exactly as they are;
 *   4. the copy reuses the very same Promotion snapshot records (`promotions_plan_snapshot_id`,
 *      migration 420): none is created or copied;
 *   5. the lifecycle change is written on the copy only.
 *
 * "The Product Set being changed" is the owner's **Active** one: it is the set the assignment
 * currently lives in. A superseded set is history and never moves, and a Draft or Pending Payment
 * set states no lifecycle of its own (its snapshots follow the Active set's, below).
 *
 * This is the one place that copy is made. It runs at the head of `syncPlanSnapshot()` for an Active
 * set, so every path that already records a transition (`recordStatusChange()`), activates a set or
 * links a cancelling plan (`linkCancellingPlans()`) goes through it; nothing calls it per route.
 */
import type { Tx } from '../infra/db';
import { CANCELS_AT_PERIOD_END_STATUS } from '../domain/assignmentStatus';
import { deleteUnlinkedPlanSnapshots } from './plan-assignment-sync';
import { copyPlanSnapshotToVersion } from './plan-snapshot-add';
import { planSnapshotSharedSql } from './plan-snapshot-lines';

/** The assignment statuses a snapshot of an Active set takes from its assignment (the sync's own list). */
const MOVED_ON = ['paused', CANCELS_AT_PERIOD_END_STATUS, 'cancelled', 'expired'] as const;
const MOVED_ON_SQL = MOVED_ON.map((s) => `'${s}'`).join(',');

/** The status a snapshot of an Active set holds for its assignment `um`. */
const WANTED_STATUS = `IF(um.status IN (${MOVED_ON_SQL}), um.status, 'active')`;
/** Whether the snapshot `s`, linked by `psj`, does not hold its assignment's lifecycle yet. */
const DIFFERS = `(NOT (s.status <=> ${WANTED_STATUS}) OR NOT (s.closed_at <=> um.closed_at)
                  OR (psj.entitlement_only = 1 AND NOT (s.ends_at <=> um.ends_at)))`;
/** The plan links of Active Product Sets with the snapshot and the assignment each is the contract of. */
const ACTIVE_LINKS_FROM = `
  FROM product_set_plan_snapshots psj
  JOIN product_sets ps ON ps.id = psj.product_set_id AND ps.status = 'active'
  JOIN plan_snapshots s ON s.id = psj.plan_snapshot_id AND s.gym_id = ps.gym_id
  JOIN user_memberships um ON um.id = s.source_user_membership_id AND um.gym_id = s.gym_id`;

/** What an in-flight (Draft or Pending Payment) set does with its link when the Active set's moves. */
export type InFlightLinkMove = 'follow' | 'drop' | 'keep';

/**
 * Pure: the review's correction 1. A pause or a resume is carried by the in-flight set (committing it
 * must not bring the previous status back). A plan cancelling at its period end stays linked for
 * entitlement only, so only such a link follows. A plan that ended is dropped from the in-flight set
 * where it was carried for entitlement; a billable link is never dropped or re-pointed by a
 * cancellation (cancelling is refused while a Draft is in flight, so there is none to decide for).
 */
export function inFlightLinkMove(newStatus: string, entitlementOnly: boolean): InFlightLinkMove {
  if (newStatus === 'active' || newStatus === 'paused') return 'follow';
  if (newStatus === CANCELS_AT_PERIOD_END_STATUS) return entitlementOnly ? 'follow' : 'keep';
  return entitlementOnly ? 'drop' : 'keep';
}

interface LinkRow {
  link_id: number; entitlement_only: number; snapshot_id: number; owner_member_id: number;
  wanted_status: string; differs: number; shared: number;
}

/**
 * Brings the plan snapshots an **Active** Product Set links in step with their assignments' lifecycle
 * where the sync cannot: a snapshot another Product Set links is copied for this set first, and a
 * snapshot linked for entitlement only (which the sync's status statement does not cover) is written
 * here. Answers how many snapshots were copied. A set that is not Active is left alone.
 */
export async function settleSharedPlanLifecycle(tx: Tx, gymId: string, productSetId: number): Promise<number> {
  const read = () => tx.query<LinkRow>(
    `SELECT psj.id AS link_id, psj.entitlement_only, s.id AS snapshot_id, ps.owner_member_id,
            ${WANTED_STATUS} AS wanted_status, ${DIFFERS} AS differs,
            ${planSnapshotSharedSql('s.id', 'psj.product_set_id')} AS shared
       ${ACTIVE_LINKS_FROM}
      WHERE ps.gym_id = ? AND psj.product_set_id = ?
      ORDER BY psj.id`, [gymId, productSetId]);

  let { rows } = await read();
  if (!rows.some((r) => Number(r.differs) === 1)) return 0;
  if (rows.some((r) => Number(r.differs) === 1 && Number(r.shared) === 1)) {
    // The links are about to move: serialise with anything else moving this set, then look again.
    await tx.query('SELECT id FROM product_sets WHERE id = ? AND gym_id = ? FOR UPDATE', [productSetId, gymId]);
    ({ rows } = await read());
  }

  let copied = 0;
  for (const r of rows) {
    if (Number(r.differs) !== 1) continue;
    const entitlementOnly = Number(r.entitlement_only) === 1;
    let target = Number(r.snapshot_id);
    if (Number(r.shared) === 1) {
      const original = target;
      target = await copyPlanSnapshotToVersion(tx, gymId, original, productSetId,
        { keepAssignment: true, link: false, reusePromotions: true });
      // The copy takes the link's place (a link is a plan's place in its set, M4b-3).
      await tx.query('UPDATE product_set_plan_snapshots SET plan_snapshot_id = ? WHERE id = ?', [target, r.link_id]);
      await moveInFlightLinks(tx, gymId, Number(r.owner_member_id), original, target, String(r.wanted_status));
      // Kept whenever anything still depends on it (a set's link, the assignment's anchor, the
      // Promotion snapshots the copy reuses); gone only when it was left with no reference at all.
      await deleteUnlinkedPlanSnapshots(tx, gymId, [original]);
      copied += 1;
    } else if (!entitlementOnly) {
      continue; // The set's own billable snapshot: the sync's status statement writes it.
    }
    await tx.query(
      `UPDATE plan_snapshots s
         JOIN user_memberships um ON um.id = s.source_user_membership_id AND um.gym_id = s.gym_id
          SET s.status = ${WANTED_STATUS}, s.closed_at = um.closed_at,
              s.ends_at = IF(?, um.ends_at, s.ends_at)
        WHERE s.id = ? AND s.gym_id = ?`, [entitlementOnly ? 1 : 0, target, gymId]);
  }
  return copied;
}

/** The owner's Draft / Pending Payment sets that link `original` follow the copy or let the plan go. */
async function moveInFlightLinks(
  tx: Tx, gymId: string, ownerMemberId: number, original: number, copy: number, newStatus: string,
): Promise<void> {
  const { rows } = await tx.query<{ id: number; entitlement_only: number }>(
    `SELECT j.id, j.entitlement_only
       FROM product_set_plan_snapshots j
       JOIN product_sets p ON p.id = j.product_set_id AND p.gym_id = ? AND p.owner_member_id = ?
                          AND p.status IN ('draft','pending_payment')
      WHERE j.plan_snapshot_id = ?`, [gymId, ownerMemberId, original]);
  for (const link of rows) {
    const move = inFlightLinkMove(newStatus, Number(link.entitlement_only) === 1);
    if (move === 'follow') {
      await tx.query('UPDATE product_set_plan_snapshots SET plan_snapshot_id = ? WHERE id = ?', [copy, link.id]);
    } else if (move === 'drop') {
      await tx.query('DELETE FROM product_set_plan_snapshots WHERE id = ?', [link.id]);
    }
  }
}

/**
 * The Active Product Sets holding a plan snapshot that does not carry its assignment's lifecycle: the
 * changes made before this stage, when the sync left a shared snapshot alone. Read-only; the repair is
 * `npm run plan-assignments:settle`, which re-runs the sync (and so the copy above) for each.
 */
export async function findUnsettledActiveSets(
  exec: { query: Tx['query'] }, gymId?: string,
): Promise<Array<{ gymId: string; productSetId: number }>> {
  const { rows } = await exec.query<{ gym_id: string; product_set_id: number }>(
    `SELECT DISTINCT ps.gym_id, ps.id AS product_set_id
       ${ACTIVE_LINKS_FROM}
      WHERE ${DIFFERS}${gymId ? ' AND ps.gym_id = ?' : ''}
      ORDER BY ps.id`, gymId ? [gymId] : []);
  return rows.map((r) => ({ gymId: String(r.gym_id), productSetId: Number(r.product_set_id) }));
}
