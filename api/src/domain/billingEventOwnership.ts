/**
 * #1325 PR 3d — which assignment a Billing Event belongs to.
 *
 * `billing_events.user_membership_id` is gone (migration 256): a money row
 * belongs to a ProductSet (`product_set_id`, 3b's CHECK), and the operational
 * assignment is a projection of the chain's Active version
 * (`product_sets.user_membership_id`, 3a). So "the events of assignment X" and
 * "the assignment of event E" are both answered through the **owner's Product
 * Sets** — #2125 M5d-2 dropped `root_product_set_id`, and an owner holds one
 * history of Product Sets (one Active at a time) — and this module is the one
 * place either question is spelled in SQL. A reader that joined
 * `user_memberships` on a column of the event would be a second answer.
 *
 * The link lives on whichever Product Set currently projects the assignment, so
 * the scalar takes the owner's latest linked Product Set; a Billing Event of
 * a superseded version is still that contract's.
 */

/**
 * Scalar subquery: the `user_memberships.id` of the owner of `<alias>.product_set_id`, or NULL (a purchase, a verification with no set, a chain whose
 * versions are all plan-less). Usable in a SELECT list or a JOIN condition.
 */
export function eventAssignmentSql(alias = 'be'): string {
  return `(SELECT p2.user_membership_id
             FROM product_sets p1
             JOIN product_sets p2
               ON p2.owner_member_id = p1.owner_member_id AND p2.gym_id = p1.gym_id
            WHERE p1.id = ${alias}.product_set_id AND p2.user_membership_id IS NOT NULL
            ORDER BY p2.id DESC
            LIMIT 1)`;
}

/**
 * Predicate: the event is on a Product Set of the owner whose Product Sets project assignment `?`. Binds
 * three parameters, in this order: `gymId, gymId, userMembershipId`.
 */
export function eventsOfAssignmentSql(alias = 'be'): string {
  return `${alias}.product_set_id IN (
            SELECT ps.id FROM product_sets ps
             WHERE ps.gym_id = ? AND ps.owner_member_id IN (
                     SELECT p2.owner_member_id FROM product_sets p2
                      WHERE p2.gym_id = ? AND p2.user_membership_id = ?))`;
}

export function eventsOfAssignmentParams(gymId: string, userMembershipId: number): [string, string, number] {
  return [gymId, gymId, userMembershipId];
}
