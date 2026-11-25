import { OWNED_ASSIGNMENTS_FROM_SQL, OWNED_ASSIGNMENT_IS_CURRENT_SQL, assignmentCoversMemberSql } from './planAssignments';

/**
 * #809: "the member's enrollment status" — the highest-priority status among their
 * assigned plans (#3113; ties: the most recent) — has two SQL readers now, so it is spelled once here.
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
/**
 * #3113: a member holding several plans reads as the highest-priority status among them —
 * Active (a plan pending cancellation still runs, so it counts as Active), then paused, then
 * Cancel on End Date, then every closed status. Ties go to the latest assignment, as before.
 *
 * #3281: "the member's plans" are the plans they **own or are covered by** — the relationship the
 * Member card's Products tab lists (`MEMBER_MEMBERSHIP_SQL`) — so a Member covered by a family
 * member's Duo reads that plan's status in the header too. Coverage is asked of each assignment's
 * **current** snapshot (`assignmentCoversMemberSql()`), never of a copy an uncommitted cart owns, so
 * a beneficiary proposed in a Draft changes nothing until it is committed. A plan that neither
 * belongs to nor covers the Member (another family member's own) is not counted.
 *
 * #3281 stage 2: the rank only *chooses* a plan; the value reported is that plan's own stored status,
 * never adapted (`to_be_canceled` stays `to_be_canceled`), and the Admin words it with the plan row's
 * own `status.<value>` key (`apps/admin/src/lib/memberPlanStatus.ts`).
 */
export function ENROLLMENT_STATUS_RANK_SQL(col: string): string {
  return `CASE WHEN ${col} IN ('active', 'to_be_canceled') THEN 0
               WHEN ${col} = 'paused' THEN 1
               WHEN ${col} IN ('active_cancel_at_period_end', 'to_be_reactivated', 'to_be_canceled_immediately') THEN 2
               ELSE 3 END`;
}

export function latestEnrollmentStatusSql(alias: string): string {
  return `(SELECT pa.status
             FROM ${OWNED_ASSIGNMENTS_FROM_SQL}
            WHERE pa.gym_id = ${alias}.gym_id
              AND (pa.member_id = ${alias}.id OR ${assignmentCoversMemberSql('pa', `${alias}.id`)})
              AND pa.status NOT IN ('in_cart', 'pending_payment')
              AND ${OWNED_ASSIGNMENT_IS_CURRENT_SQL}
            ORDER BY ${ENROLLMENT_STATUS_RANK_SQL('pa.status')}, anc.created_at DESC, pa.anchor_plan_snapshot_id DESC
            LIMIT 1)`;
}
