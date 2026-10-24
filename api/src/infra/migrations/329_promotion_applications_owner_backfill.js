/**
 * #1995 stage 3 — Membership Plan Promotion applications are read by
 * `user_membership_id`.
 *
 * Stage 1 added the column and stage 2 started writing it at projection; the
 * readers (pricing, the Assigned Plan card, `/me/promotions`, the Professional
 * Service grants) now join on it instead of on the assignment's latest version.
 * Any Membership Plan application written between stage 1 and this stage by a
 * set-first Draft still has it NULL, which would make the application invisible,
 * so it is filled from the version's OWN link only (never the chain's latest:
 * a clone Draft belongs to its successor assignment, attached at projection).
 * `product_set_id` is kept: it still keys Product-target applications and a
 * Draft not yet projected. Idempotent; one-way.
 */
exports.up = async function up(knex) {
  await knex.raw(
    `UPDATE user_membership_promotions ump
       JOIN product_sets ps ON ps.id = ump.product_set_id AND ps.user_membership_id IS NOT NULL
       JOIN promotions pr ON pr.id = ump.promotion_id AND pr.applies_to = 'membership_plan'
        SET ump.user_membership_id = ps.user_membership_id
      WHERE ump.user_membership_id IS NULL`);
};

exports.down = async function down() {
  // One-way: the key is re-derivable from the version.
};
