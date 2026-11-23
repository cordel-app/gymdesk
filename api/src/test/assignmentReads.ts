/**
 * #2125 M6b-51d-4 — an assignment read under the legacy `user_memberships` column names, from the
 * model that replaces the table.
 *
 * A test that checks what an API call did to an assignment (its status, dates, closure, owner, plan,
 * creator or modifier) reads `TEST_ASSIGNMENTS` instead of `user_memberships`, so the assertion is
 * about the record that survives the table: the assignment's **anchor** snapshot
 * (`plan_snapshots.assignment_id = id`) for its identity and lifecycle (`assignment_status`,
 * `assignment_closed_at`, `assignment_ends_at`, `assignment_modified_*`, M6b-51c-4, written by
 * `writeAssignmentLifecycle()` and `insertAssignment()`), and its **current** snapshot
 * (`currentAssignmentSnapshotSql()`) for its start date and the facts the writers stamp there
 * (`purchased_at`, the replacement, the soft-delete pair). Interpolate it where the table was named
 * (`FROM ${TEST_ASSIGNMENTS} um WHERE um.id = ?`); `id` is the legacy id the routes still name.
 *
 * Test-only: production reads go through `domain/planAssignments.ts`. A fixture that hand-writes a
 * `user_memberships` row reaches this table only once that row has an anchor
 * (`legacyAssignmentQuery()`, `snapshotTestAssignment()`), exactly as every production reader does.
 */
import { currentAssignmentSnapshotSql } from '../domain/planAssignments';

export const TEST_ASSIGNMENTS = `(
  SELECT anc.assignment_id AS id, anc.gym_id, anc.member_id, anc.membership_plan_id,
         anc.assignment_status AS status, COALESCE(pa.starts_at, anc.starts_at) AS starts_at,
         anc.assignment_ends_at AS ends_at, anc.assignment_closed_at AS closed_at,
         anc.created_at, anc.created_by,
         anc.assignment_modified_at AS modified_at, anc.assignment_modified_by AS modified_by,
         pa.deleted_at, pa.deleted_by, pa.purchased_at, pa.replace_on_activation,
         (SELECT rep.assignment_id FROM plan_snapshots rep
           WHERE rep.id = pa.replaces_assignment_id AND rep.gym_id = pa.gym_id) AS replaces_user_membership_id
    FROM plan_snapshots anc
    LEFT JOIN plan_snapshots pa
      ON pa.id = ${currentAssignmentSnapshotSql('anc.id', 'anc.gym_id')}
   WHERE anc.assignment_id = anc.id AND anc.assignment_id IS NOT NULL)`;
