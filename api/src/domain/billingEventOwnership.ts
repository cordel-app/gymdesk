/**
 * #1325 PR 3d — which assignment a Billing Event belongs to.
 *
 * `billing_events.user_membership_id` is gone (migration 256): a money row
 * belongs to a ProductSet (`product_set_id`, 3b's CHECK), and the operational
 * assignment is a projection of the chain's Active version
 * (`product_sets.user_membership_id`, 3a). So "the events of assignment X" and
 * "the assignment of event E" are both answered through the **chain** — every
 * version of a `root_product_set_id` is one contract — and this module is the
 * one place either question is spelled in SQL. A reader that joined
 * `user_memberships` on a column of the event would be a second answer.
 *
 * The link lives on whichever version currently projects the assignment, so
 * the scalar takes the latest linked version of the chain; a Billing Event of
 * a superseded version is still that contract's.
 */

/**
 * Scalar subquery: the `user_memberships.id` of the chain `<alias>.product_set_id`
 * belongs to, or NULL (a purchase, a verification with no set, a chain whose
 * versions are all plan-less). Usable in a SELECT list or a JOIN condition.
 */
export function eventAssignmentSql(alias = 'be'): string {
  return `(SELECT p2.user_membership_id
             FROM product_sets p1
             JOIN product_sets p2
               ON p2.root_product_set_id = p1.root_product_set_id AND p2.gym_id = p1.gym_id
            WHERE p1.id = ${alias}.product_set_id AND p2.user_membership_id IS NOT NULL
            ORDER BY p2.version DESC, p2.id DESC
            LIMIT 1)`;
}

/**
 * Predicate: the event is on the chain assignment `?` projects from. Binds
 * three parameters, in this order: `gymId, gymId, userMembershipId`.
 */
export function eventsOfAssignmentSql(alias = 'be'): string {
  return `${alias}.product_set_id IN (
            SELECT ps.id FROM product_sets ps
             WHERE ps.gym_id = ? AND ps.root_product_set_id IN (
                     SELECT p2.root_product_set_id FROM product_sets p2
                      WHERE p2.gym_id = ? AND p2.user_membership_id = ?))`;
}

export function eventsOfAssignmentParams(gymId: string, userMembershipId: number): [string, string, number] {
  return [gymId, gymId, userMembershipId];
}
