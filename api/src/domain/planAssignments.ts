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

/**
 * #2125 M6b-10 — predicate: the `plan_snapshots` row `alias` is the current snapshot of the
 * assignment a legacy `user_memberships` id names. Routes, payment requests and audit rows still
 * name an assignment by that id, and every snapshot of one carries it
 * (`source_user_membership_id`); one legacy id is exactly one `assignment_id` (M6b-1), so this
 * matches at most one row. For a reader that needs what never changes over an assignment's life
 * (its owner, its Membership Plan), so it holds whatever the assignment's status is.
 */
export const assignmentOfLegacyIdSql = (legacyIdExpr: string, alias = 'pa'): string =>
  `(${alias}.source_user_membership_id = ${legacyIdExpr} AND ${isCurrentAssignmentSnapshotSql(alias)})`;

/**
 * #2125 M6b-13 — the current snapshot of every assignment a Member **owns**, as rows shaped like
 * the `user_memberships` row they replace, for the readers that need a closed plan's status and
 * dates (the New Member rule, the enrollment status). Needs the settle run (M6b-6/7), which is
 * what makes a closed assignment's current snapshot carry its closed status and dates.
 *
 * `created_at` is the assignment's, not the snapshot's: the anchor snapshot (`assignment_id`) is
 * the assignment's first, while a lifecycle copy is written later and would date the assignment by
 * its last change. Alias `pa` is the current snapshot and `anc` its anchor; the caller adds its own
 * owner predicate on `pa.member_id`.
 */
export const OWNED_ASSIGNMENTS_FROM_SQL =
  `plan_snapshots pa JOIN plan_snapshots anc ON anc.id = pa.assignment_id AND anc.gym_id = pa.gym_id`;

/** Predicate over `OWNED_ASSIGNMENTS_FROM_SQL`: `pa` is the current snapshot of its assignment. */
export const OWNED_ASSIGNMENT_IS_CURRENT_SQL = isCurrentAssignmentSnapshotSql('pa');
