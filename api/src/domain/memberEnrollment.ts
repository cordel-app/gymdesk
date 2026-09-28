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
 */
export function latestEnrollmentStatusSql(alias: string): string {
  return `(SELECT um.status
             FROM user_memberships um
            WHERE um.member_id = ${alias}.id AND um.gym_id = ${alias}.gym_id
            ORDER BY um.created_at DESC, um.id DESC LIMIT 1)`;
}
