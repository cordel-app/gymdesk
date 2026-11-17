import { OWNED_ASSIGNMENTS_FROM_SQL, OWNED_ASSIGNMENT_IS_CURRENT_SQL } from './planAssignments';

/**
 * #809: "the member's enrollment status" — the status of their most recent
 * `user_memberships` row — has two SQL readers now, so it is spelled once here.
 *
 * `GET /members` projects it as the `enrollment_status` column the Members list
 * shows and filters on, and the Nutrition Dashboard counts a Nutrition Plan's
 * **active members** with it. Both have to mean the same thing: a gym owner
 * reading `12 active members` off a dashboard card and then filtering the
 * Members page by `Enrollment status: Active` must not get two different sets.
 *
 * `alias` is the SQL alias of the `members` row in the caller's query — a
 * code-level identifier, never request input.
 *
 * #1108 stage 1: a **Draft is not an enrollment**. It is the configuration of a
 * purchase nobody has committed, so it is excluded rather than reported — and
 * excluded rather than merely ranked last, because this reads the *most
 * recently created* row: a Draft replacement configured for a member who is
 * currently Active would otherwise have overwritten their enrollment status on
 * the Members list and dropped them out of the Nutrition Dashboard's active
 * count. A member whose only assignment is a Draft reads as having none, which
 * is exactly what they have.
 *
 * #2125 M6b-13: read from `plan_snapshots` — each assignment's current snapshot
 * (`domain/planAssignments.ts`), ordered by when the assignment was created (its
 * anchor snapshot) and then by its id, as the legacy row was by `created_at, id`.
 */
export function latestEnrollmentStatusSql(alias: string): string {
  return `(SELECT pa.status
             FROM ${OWNED_ASSIGNMENTS_FROM_SQL}
            WHERE pa.member_id = ${alias}.id AND pa.gym_id = ${alias}.gym_id
              AND pa.status NOT IN ('in_cart', 'pending_payment')
              AND ${OWNED_ASSIGNMENT_IS_CURRENT_SQL}
            ORDER BY anc.created_at DESC, pa.assignment_id DESC LIMIT 1)`;
}
