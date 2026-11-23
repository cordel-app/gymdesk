/**
 * #2125 M6b-3 — a Membership Plan assignment read from `plan_snapshots`, the record that replaces
 * `user_memberships` (Oscar's option A).
 *
 * An assignment is the snapshots sharing one `anchor_plan_snapshot_id` (M6b-1). At any moment exactly one of
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
     WHERE cas.anchor_plan_snapshot_id = ${assignmentExpr} AND cas.gym_id = ${gymExpr}
     ORDER BY (cap.status = 'active') DESC, cap.id DESC, cas.id DESC LIMIT 1)`;

/** Predicate: the `plan_snapshots` row `alias` is the current snapshot of its assignment. */
export const isCurrentAssignmentSnapshotSql = (alias = 'pa'): string =>
  `${alias}.id = ${currentAssignmentSnapshotSql(`${alias}.anchor_plan_snapshot_id`, `${alias}.gym_id`)}`;

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
 * assignment an assignment id (`anchor_plan_snapshot_id`) names. Routes, payment requests and audit rows still
 * name an assignment by that id, and every snapshot of one carries it
 * (`anchor_plan_snapshot_id`); one legacy id is exactly one `anchor_plan_snapshot_id` (M6b-1), so this
 * matches at most one row. For a reader that needs what never changes over an assignment's life
 * (its owner, its Membership Plan), so it holds whatever the assignment's status is. Since the
 * settle run (M6b-13) the current snapshot of a closed assignment carries its closed status, so a
 * reader may ask that status through it too (M6b-15: a staff-raised payment request).
 */
export const assignmentOfLegacyIdSql = (legacyIdExpr: string, alias = 'pa'): string =>
  `(${alias}.anchor_plan_snapshot_id = ${legacyIdExpr} AND ${isCurrentAssignmentSnapshotSql(alias)})`;

/**
 * #2125 M6b-37 — predicate: the `plan_snapshots` row `alias` is the current snapshot of the
 * assignment an anchor names (`plan_snapshots.anchor_plan_snapshot_id`, the id of its first snapshot). For a
 * reader that already holds the anchor, which since M6b-36 is `product_sets.plan_assignment_id`:
 * it asks the assignment by its own identity rather than through the assignment id
 * (`assignmentOfLegacyIdSql()`), which is how a Product Set's readers stop reading
 * `product_sets.user_membership_id` before that column is dropped.
 */
export const assignmentOfAnchorSql = (anchorExpr: string, alias = 'pa'): string =>
  `(${alias}.anchor_plan_snapshot_id = ${anchorExpr} AND ${isCurrentAssignmentSnapshotSql(alias)})`;

/**
 * #2125 M6b-13 — the current snapshot of every assignment a Member **owns**, as rows shaped like
 * the `user_memberships` row they replace, for the readers that need a closed plan's status and
 * dates (the New Member rule, the enrollment status). Needs the settle run (M6b-6/7), which is
 * what makes a closed assignment's current snapshot carry its closed status and dates.
 *
 * `created_at` is the assignment's, not the snapshot's: the anchor snapshot (`anchor_plan_snapshot_id`) is
 * the assignment's first, while a lifecycle copy is written later and would date the assignment by
 * its last change. Alias `pa` is the current snapshot and `anc` its anchor; the caller adds its own
 * owner predicate on `pa.member_id`.
 */
export const OWNED_ASSIGNMENTS_FROM_SQL =
  `plan_snapshots pa JOIN plan_snapshots anc ON anc.id = pa.anchor_plan_snapshot_id AND anc.gym_id = pa.gym_id`;

/** Predicate over `OWNED_ASSIGNMENTS_FROM_SQL`: `pa` is the current snapshot of its assignment. */
export const OWNED_ASSIGNMENT_IS_CURRENT_SQL = isCurrentAssignmentSnapshotSql('pa');

/**
 * #2125 M6b-14 — one Member's owned assignments as a derived table shaped like the
 * `user_memberships` rows it replaces (`id` is the legacy id the routes still name, `created_at`
 * the assignment's, from its anchor), for the member's own plan reads: `GET /me/membership`'s
 * current plan, other live plans, Drafts and Past list, and the Payments forecast, which must pick
 * the same assignment through `MEMBER_CURRENT_ASSIGNMENT_ORDER`. Each assignment's current
 * snapshot; a snapshot that names no legacy row is left out, as it was when these read the table.
 * Binds two `?`: the gym id, then the member id. Use it as `FROM ${OWNED_ASSIGNMENT_ROWS_SQL} um`.
 */
export const OWNED_ASSIGNMENT_ROWS_SQL = `(
  SELECT pa.anchor_plan_snapshot_id AS id, pa.gym_id, pa.member_id, pa.membership_plan_id,
         pa.status, pa.starts_at, pa.ends_at, pa.closed_at, anc.created_at
    FROM ${OWNED_ASSIGNMENTS_FROM_SQL}
   WHERE pa.gym_id = ? AND pa.member_id = ? AND pa.anchor_plan_snapshot_id IS NOT NULL
     AND ${OWNED_ASSIGNMENT_IS_CURRENT_SQL})`;

/**
 * #2125 M6b-31 — the assignment's last modification, read off its snapshots. M6b-30 dual-writes
 * `modified_at` / `modified_by` onto a snapshot no other Product Set links (a copy carries its
 * source's), so the assignment's latest modifier is on whichever of its snapshots was written last,
 * not necessarily on the current one. One correlated subquery per column, over the snapshot
 * `alias`'s assignment: the latest non-null `modified_at`, ties to the latest snapshot.
 */
export const assignmentModifierSql = (column: 'modified_at' | 'modified_by', alias = 'pa'): string =>
  `(SELECT amod.${column} FROM plan_snapshots amod
     WHERE amod.anchor_plan_snapshot_id = ${alias}.anchor_plan_snapshot_id AND amod.gym_id = ${alias}.gym_id
     ORDER BY amod.modified_at IS NULL, amod.modified_at DESC, amod.id DESC LIMIT 1)`;

/**
 * #2125 M6b-31 — every assignment of one gym as its current snapshot, with what the Member card's
 * plan history reports beside the lifecycle: the assignment's creation (its anchor snapshot's
 * `created_at` / `created_by`, the anchor being the assignment's first snapshot, M6b-13's rule),
 * its last modification (`assignmentModifierSql()`) and the soft-delete pair of the current
 * snapshot. Shaped like the `user_memberships` row it replaces (`id` is the legacy id).
 * M6b-32: every column of that row, so `LIST_SELECT` (the assignments list and every write's
 * answer) reads it as `um.*`: `purchased_at` and `replace_on_activation` off the current snapshot,
 * and `replaces_user_membership_id` as the legacy id of the assignment the current snapshot's
 * `replaces_assignment_id` names.
 * Binds one `?`: the gym id. Use it as `FROM ${ASSIGNMENT_HISTORY_ROWS_SQL} um`.
 */
export const ASSIGNMENT_HISTORY_ROWS_SQL = `(
  SELECT pa.anchor_plan_snapshot_id AS id, pa.gym_id, pa.member_id, pa.membership_plan_id,
         pa.status, pa.starts_at, pa.ends_at, pa.closed_at, anc.created_at, anc.created_by,
         ${assignmentModifierSql('modified_at')} AS modified_at,
         ${assignmentModifierSql('modified_by')} AS modified_by,
         pa.deleted_at, pa.deleted_by,
         pa.purchased_at, pa.replace_on_activation,
         (SELECT rep.anchor_plan_snapshot_id FROM plan_snapshots rep
           WHERE rep.id = pa.replaces_assignment_id AND rep.gym_id = pa.gym_id) AS replaces_user_membership_id
    FROM ${OWNED_ASSIGNMENTS_FROM_SQL}
   WHERE pa.gym_id = ? AND pa.anchor_plan_snapshot_id IS NOT NULL
     AND ${OWNED_ASSIGNMENT_IS_CURRENT_SQL})`;

/**
 * #2125 M6b-17 — every assignment of one gym as a derived table shaped like the `user_memberships`
 * rows it replaces, each read from its current snapshot (`OWNED_ASSIGNMENT_ROWS_SQL` without the
 * owner bound), for a reader that scopes the assignments itself: the Billing Simulation's loader
 * (by owner or by legacy id). `id` is the legacy id the routes still name; a snapshot that names no
 * legacy row is left out. Binds one `?`: the gym id. Use it as `FROM ${GYM_ASSIGNMENT_ROWS_SQL} um`.
 */
export const GYM_ASSIGNMENT_ROWS_SQL = `(
  SELECT pa.anchor_plan_snapshot_id AS id, pa.gym_id, pa.member_id, pa.membership_plan_id,
         pa.status, pa.starts_at, pa.ends_at, pa.closed_at, anc.created_at
    FROM ${OWNED_ASSIGNMENTS_FROM_SQL}
   WHERE pa.gym_id = ? AND pa.anchor_plan_snapshot_id IS NOT NULL
     AND ${OWNED_ASSIGNMENT_IS_CURRENT_SQL})`;

/**
 * #2125 M6b-41 — predicate: the Product Set `alias` is linked to the assignment an assignment id
 * (`anchor_plan_snapshot_id`) names. Asked of the set's anchor (`product_sets.plan_assignment_id`,
 * M6b-36), the lowest snapshot naming that legacy id (the rule `PRODUCT_SET_ASSIGNMENT_ANCHOR_SQL`
 * writes), never of `product_sets.user_membership_id`, the column the re-key drops. For the
 * lookups that are handed a legacy id and want the sets linked to it; `legacyIdExpr` is a column
 * or a `?`.
 */
export const productSetOfLegacyAssignmentSql = (legacyIdExpr: string, alias = 'ps'): string =>
  `${alias}.plan_assignment_id = (SELECT MIN(ps_anc.id) FROM plan_snapshots ps_anc
                                   WHERE ps_anc.gym_id = ${alias}.gym_id
                                     AND ps_anc.anchor_plan_snapshot_id = ${legacyIdExpr})`;

/**
 * #2125 M6b-42 — the assignment id (`anchor_plan_snapshot_id`) of the assignment the Product Set `alias` is
 * linked to, read off the set's anchor (`product_sets.plan_assignment_id`, M6b-36): the anchor
 * snapshot's own `anchor_plan_snapshot_id`, which is that legacy id by construction (the anchor is
 * the lowest snapshot naming it). NULL for a set linked to no assignment. For a reader that needs the
 * value of the link, never `product_sets.user_membership_id`, the column the re-key drops.
 */
export const productSetLegacyAssignmentIdSql = (alias = 'ps'): string =>
  `(SELECT ps_lid.anchor_plan_snapshot_id FROM plan_snapshots ps_lid
     WHERE ps_lid.id = ${alias}.plan_assignment_id AND ps_lid.gym_id = ${alias}.gym_id)`;

/**
 * #2125 N3a — the value a new `payment_requests.anchor_plan_snapshot_id` is written with: the anchor
 * plan snapshot whose id is the assignment id bound to the first `?`, of the gym bound to the second,
 * or NULL where no snapshot of that gym anchors that id (an id read off a request body, a stale page).
 * Written inside the INSERT so a payment request can never name a snapshot that is not an anchor.
 */
export const ANCHOR_PLAN_SNAPSHOT_VALUE_SQL =
  `(SELECT pa_req.id FROM plan_snapshots pa_req
     WHERE pa_req.id = ? AND pa_req.gym_id = ? AND pa_req.anchor_plan_snapshot_id = pa_req.id)`;
