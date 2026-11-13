/**
 * #2125 M6b-3 — a Membership Plan assignment read from `plan_snapshots`, the record that replaces
 * `user_memberships` (Oscar's option A).
 *
 * An assignment is the snapshots sharing one `assignment_id` (M6b-1). At any moment exactly one of
 * them says what the assignment is now, and this is the one place that says which:
 *
 *   1. the snapshot the owner's **Active** Product Set links. The Active set is the set the
 *      assignment lives in: a pause, a resume and a cancellation are written on its snapshot
 *      (M6b-2), and covered Members follow it. A Draft or Pending Payment set states no lifecycle
 *      of its own, so a copy such a set owns (a proposed change nobody committed) never answers
 *      for the running plan;
 *   2. otherwise the snapshot of the latest Product Set linking the assignment: a Draft-only
 *      assignment, or a closed one whose last set is superseded.
 *
 * A snapshot no Product Set links is not an assignment's state at all.
 *
 * Readers move onto this group by group; `plan-assignment-legacy-readers.unit.test.ts` pins the
 * `user_memberships` statements that are left, and that list may only shrink. Do not add a second
 * spelling of "which snapshot is the assignment's" beside this one.
 */
import { entitledAssignmentSql } from './assignmentStatus';

/** SQL for the id of the snapshot that states an assignment's current identity, dates and status. */
export const currentAssignmentSnapshotSql = (assignmentExpr: string, gymExpr: string): string =>
  `(SELECT cas.id FROM product_set_plan_snapshots caj
      JOIN plan_snapshots cas ON cas.id = caj.plan_snapshot_id
      JOIN product_sets cap ON cap.id = caj.product_set_id
     WHERE cas.assignment_id = ${assignmentExpr} AND cas.gym_id = ${gymExpr}
     ORDER BY (cap.status = 'active') DESC, cap.id DESC, cas.id DESC LIMIT 1)`;

/** Predicate: the `plan_snapshots` row `alias` is the current snapshot of its assignment. */
export const isCurrentAssignmentSnapshotSql = (alias = 'pa'): string =>
  `${alias}.id = ${currentAssignmentSnapshotSql(`${alias}.assignment_id`, `${alias}.gym_id`)}`;

/**
 * Predicate: the `plan_snapshots` row `alias` is an assignment that entitles its beneficiaries
 * today (`entitledAssignmentSql()`, #2659 stage 2, asked of the current snapshot).
 */
export const entitlingAssignmentSql = (alias = 'pa'): string =>
  `(${entitledAssignmentSql(alias)} AND ${isCurrentAssignmentSnapshotSql(alias)})`;

/**
 * Predicate: the assignment whose snapshot is `alias` covers a Member (one `?`: the member id).
 * Coverage is the snapshot's own `plan_snapshot_beneficiaries` (#2125 stage 21); the payer is not
 * a beneficiary unless the plan says so (stage 22).
 */
export const assignmentCoversMemberSql = (alias = 'pa'): string =>
  `EXISTS (SELECT 1 FROM plan_snapshot_beneficiaries pab
            WHERE pab.plan_snapshot_id = ${alias}.id AND pab.gym_id = ${alias}.gym_id AND pab.member_id = ?)`;
