import { planSnapshotInheritedSql } from './plan-snapshot-lines';

/**
 * #2887 — which cancelled Product Sets are a past Membership Plan of their own.
 *
 * #2747 lists a Product Set cancelled while it awaited its first payment under
 * Past, because a plan chosen and never paid has no assignment row to read as
 * history. But a Pending Payment set is not always a new plan: a cart that only
 * added Products (#2746) carries the member's running plan along, linked from
 * the previous set or copied from it. Cancelling that cart cancels no plan — the
 * plan is still the Active assignment — so listing the set under Past counted
 * the running plan a second time, and the Past count disagreed with what the
 * member actually ended.
 *
 * A cancelled set is therefore a past plan only when it links a plan snapshot
 * the set itself added: not inherited from the previous set
 * (`planSnapshotInheritedSql()`, the one derivation of "carried over") and
 * naming no assignment (`assignment_id`), since an assignment is
 * already a row of the history. Used by both readers of that list — the Member
 * card's configuration read and the Members App's `GET /me/membership` — so the
 * two cannot disagree. Bind nothing; it expects the set aliased `ps`.
 */
export const CANCELLED_PLAN_SET_SQL = `ps.status = 'cancelled'
        AND ps.membership_plan_id IS NOT NULL AND ps.plan_assignment_id IS NULL
        AND EXISTS (
          SELECT 1 FROM product_set_plan_snapshots cpj_
            JOIN plan_snapshots cps_ ON cps_.id = cpj_.plan_snapshot_id
           WHERE cpj_.product_set_id = ps.id
             AND cps_.assignment_id IS NULL
             AND NOT ${planSnapshotInheritedSql('cps_', 'ps.id')})`;
