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
 *
 * M6b-6 — a plan that **ended** states so on a snapshot too. An assignment closed at once (cancelled
 * with nothing left to run, replaced, expired, or superseded by a changed plan) leaves the Active set,
 * so nothing above reached it: its last snapshot kept reading `active` where older Product Sets share
 * it. Oscar's cancellation workflow says where the closed state goes: the Product Set the change
 * produced holds a copy of the snapshot (same `assignment_id`) carrying the new status.
 * `carryClosedAssignments()` therefore links such a snapshot to the owner's Active set **for the record
 * only** (`entitlement_only = 1`: never billed, projected, primary or cloned onto a successor), and the
 * copy rule above then writes the closed status on that set's own copy. The snapshot a superseded set
 * alone links is written in place by the sync (`plan-snapshot-sync.ts`), so no copy is made for it.
 */
import type { Tx } from '../infra/db';
import { CANCELS_AT_PERIOD_END_STATUS } from '../domain/assignmentStatus';
import { currentAssignmentSnapshotSql } from '../domain/planAssignments';
import { deleteUnlinkedPlanSnapshots } from './plan-assignment-sync';
import { copyPlanSnapshotToVersion } from './plan-snapshot-add';
import { planSnapshotSharedSql } from './plan-snapshot-lines';

/** The assignment statuses a snapshot of an Active set takes from its assignment (the sync's own list). */
const MOVED_ON = ['paused', CANCELS_AT_PERIOD_END_STATUS, 'cancelled', 'expired'] as const;
const MOVED_ON_SQL = MOVED_ON.map((s) => `'${s}'`).join(',');

/**
 * The statuses of an assignment that is over. `superseded` (a changed plan took it over) is stated
 * only on a link carried for the record: on a billable link it is the transient of a successor's
 * activation, whose snapshot is about to name the new assignment.
 */
export const CLOSED_ASSIGNMENT_STATUSES = ['cancelled', 'expired', 'superseded'] as const;
const CLOSED_SQL = CLOSED_ASSIGNMENT_STATUSES.map((s) => `'${s}'`).join(',');

/** The assignment (`um`) the plan snapshot `s` is the contract of, while both records exist. */
const ASSIGNMENT_OF_SNAPSHOT = 'JOIN user_memberships um ON um.id = s.source_user_membership_id AND um.gym_id = s.gym_id';

/** The status a snapshot of an Active set, linked by `psj`, holds for its assignment `um`. */
const WANTED_STATUS = `IF(um.status IN (${MOVED_ON_SQL}) OR (psj.entitlement_only = 1 AND um.status = 'superseded'), um.status, 'active')`;
/** Whether the snapshot `s`, linked by `psj`, does not hold its assignment's lifecycle yet. */
const DIFFERS = `(NOT (s.status <=> ${WANTED_STATUS}) OR NOT (s.closed_at <=> um.closed_at)
                  OR (psj.entitlement_only = 1 AND NOT (s.ends_at <=> um.ends_at)))`;
/** The plan links of Active Product Sets with the snapshot and the assignment each is the contract of. */
const ACTIVE_LINKS_FROM = `
  FROM product_set_plan_snapshots psj
  JOIN product_sets ps ON ps.id = psj.product_set_id AND ps.status = 'active'
  JOIN plan_snapshots s ON s.id = psj.plan_snapshot_id AND s.gym_id = ps.gym_id
  ${ASSIGNMENT_OF_SNAPSHOT}`;

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
  await carryClosedAssignments(tx, gymId, productSetId);
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
      await moveSessionLedger(tx, gymId, original, target);
      // Kept whenever anything still depends on it (a set's link, the assignment's anchor, the
      // Promotion snapshots the copy reuses); gone only when it was left with no reference at all.
      await deleteUnlinkedPlanSnapshots(tx, gymId, [original]);
      copied += 1;
    } else if (!entitlementOnly) {
      continue; // The set's own billable snapshot: the sync's status statement writes it.
    }
    await tx.query(
      `UPDATE plan_snapshots s
         JOIN product_set_plan_snapshots psj ON psj.id = ?
         ${ASSIGNMENT_OF_SNAPSHOT}
          SET s.status = ${WANTED_STATUS}, s.closed_at = um.closed_at,
              s.ends_at = IF(psj.entitlement_only = 1, um.ends_at, s.ends_at)
        WHERE s.id = ? AND s.gym_id = ?`, [r.link_id, target, gymId]);
  }
  return copied;
}

/**
 * The owner's assignments that are over and whose current snapshot (`currentAssignmentSnapshotSql()`)
 * does not say so, for the **Active** Product Set `productSetId` (no row for any other set).
 * `s` is the assignment's anchor, `cur` the snapshot that states it now.
 */
const UNSTATED_CLOSED_FROM = `
  FROM product_sets ps
  JOIN plan_snapshots s ON s.gym_id = ps.gym_id AND s.member_id = ps.owner_member_id AND s.assignment_id = s.id
  ${ASSIGNMENT_OF_SNAPSHOT} AND um.status IN (${CLOSED_SQL})
  JOIN plan_snapshots cur ON cur.gym_id = s.gym_id AND cur.id = ${currentAssignmentSnapshotSql('s.id', 's.gym_id')}
                         AND cur.source_user_membership_id = um.id
 WHERE ps.status = 'active' AND NOT (cur.status <=> um.status)`;

/**
 * M6b-6: links, for the record only, the current snapshot of each of the owner's ended assignments
 * that does not hold the assignment's closed status, so the copy rule writes it on this set's own
 * copy. Idempotent and convergent: once the status is stated the assignment is not listed again, a
 * snapshot this set already links is left to the rule above, and a set that is not Active does nothing.
 */
async function carryClosedAssignments(tx: Tx, gymId: string, productSetId: number): Promise<void> {
  const { rows } = await tx.query<{ snapshot_id: number }>(
    `SELECT DISTINCT cur.id AS snapshot_id ${UNSTATED_CLOSED_FROM} AND ps.gym_id = ? AND ps.id = ?
      ORDER BY cur.id`, [gymId, productSetId]);
  for (const r of rows) {
    await tx.query(
      `INSERT IGNORE INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id, entitlement_only)
       VALUES (?, ?, 1)`, [productSetId, Number(r.snapshot_id)]);
  }
}

/**
 * M6b-4: the assignment's Session Benefit ledger follows it onto the copy. A plan's session grant is
 * identified by its `plan_session_snapshots` line (migration 354), and the copy has lines of its own,
 * so the renewals granted, the sessions spent and the units reserved against the original's lines are
 * re-pointed at the copy's matching lines (same Product, same member). They are the assignment's, and
 * the copy is where the assignment lives from here on; left behind, a paused and resumed plan would
 * read as never renewed and never spent.
 */
async function moveSessionLedger(tx: Tx, gymId: string, original: number, copy: number): Promise<void> {
  const LINES = `
    JOIN plan_session_snapshots o ON o.id = %REF% AND o.plan_snapshot_id = ? AND o.gym_id = l.gym_id
    JOIN plan_session_snapshots c ON c.plan_snapshot_id = ? AND c.gym_id = o.gym_id
                                 AND c.product_id = o.product_id AND c.assigned_member_id <=> o.assigned_member_id`;
  await tx.query(
    `UPDATE plan_allowance_renewals l ${LINES.replace('%REF%', 'l.plan_session_snapshot_id')}
        SET l.plan_session_snapshot_id = c.id WHERE l.gym_id = ?`, [original, copy, gymId]);
  for (const table of ['professional_service_consumptions', 'professional_service_reservations']) {
    await tx.query(
      `UPDATE ${table} l ${LINES.replace('%REF%', 'l.source_reference_id')}
          SET l.source_reference_id = c.id WHERE l.gym_id = ? AND l.source_kind = 'plan_session'`, [original, copy, gymId]);
  }
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
 * M6b-7: the **superseded** Product Sets whose own plan snapshot is the current snapshot of an
 * assignment that is over and does not hold the assignment's closed status, `closed_at` or end date.
 * It is the unshared half of M6b-6: the sync writes such a snapshot in place, so re-syncing the set
 * is the whole repair. `superseded` is never compared as a status here (the set's own status already
 * reads it); a shared snapshot is the Active set's to carry (`carryClosedAssignments()`).
 */
const UNSTATED_CLOSED_IN_PLACE_FROM = `
  FROM product_set_plan_snapshots psj
  JOIN product_sets ps ON ps.id = psj.product_set_id AND ps.status = 'superseded'
  JOIN plan_snapshots s ON s.id = psj.plan_snapshot_id AND s.gym_id = ps.gym_id
  ${ASSIGNMENT_OF_SNAPSHOT} AND um.status IN (${CLOSED_SQL})
 WHERE psj.entitlement_only = 0
   AND NOT ${planSnapshotSharedSql('s.id', 'psj.product_set_id')}
   AND s.id = ${currentAssignmentSnapshotSql('s.assignment_id', 's.gym_id')}
   AND (NOT (s.ends_at <=> um.ends_at) OR NOT (s.closed_at <=> um.closed_at)
        OR (um.status <> 'superseded' AND NOT (s.status <=> um.status)))`;

/**
 * The Active Product Sets holding a plan snapshot that does not carry its assignment's lifecycle: the
 * changes made before this stage, when the sync left a shared snapshot alone. Read-only; the repair is
 * `npm run plan-assignments:settle`, which re-runs the sync (and so the copy above) for each.
 */
export async function findUnsettledActiveSets(
  exec: { query: Tx['query'] }, gymId?: string,
): Promise<Array<{ gymId: string; productSetId: number }>> {
  const scope = gymId ? ' AND ps.gym_id = ?' : '';
  const params = gymId ? [gymId] : [];
  // M6b-6: and the Active sets whose owner holds an ended assignment no snapshot states as ended.
  // M6b-7: and the superseded sets whose own snapshot of an ended assignment lacks its status or dates.
  const { rows } = await exec.query<{ gym_id: string; product_set_id: number }>(
    `SELECT ps.gym_id, ps.id AS product_set_id
       ${ACTIVE_LINKS_FROM}
      WHERE ${DIFFERS}${scope}
     UNION
     SELECT ps.gym_id, ps.id AS product_set_id ${UNSTATED_CLOSED_FROM}${scope}
     UNION
     SELECT ps.gym_id, ps.id AS product_set_id ${UNSTATED_CLOSED_IN_PLACE_FROM}${scope}
      ORDER BY product_set_id`, [...params, ...params, ...params]);
  return rows.map((r) => ({ gymId: String(r.gym_id), productSetId: Number(r.product_set_id) }));
}
