/**
 * #1325 follow-up to migration 262: `user_membership_members` is a read of the
 * ProductSet chain's coverage, and its `DISTINCT` (there only because several
 * versions of one chain may link to the same assignment) made MySQL materialise
 * the view for every query. The view now keeps one row per (assignment, chain,
 * member) by taking only the latest version of the chain linked to the
 * assignment, so it is a plain join MySQL can merge and index.
 *
 * Non-destructive: only the view definition changes. `down()` restores 262's.
 */
exports.up = async function up(knex) {
  await knex.raw(
    `CREATE OR REPLACE VIEW user_membership_members AS
     SELECT ps.user_membership_id AS user_membership_id, psm.gym_id AS gym_id,
            psm.member_id AS member_id, psm.is_owner AS is_owner, psm.created_at AS created_at
       FROM product_sets ps
       JOIN product_set_members psm
         ON psm.root_product_set_id = ps.root_product_set_id AND psm.gym_id = ps.gym_id
      WHERE ps.user_membership_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM product_sets p2
                         WHERE p2.user_membership_id = ps.user_membership_id
                           AND p2.root_product_set_id = ps.root_product_set_id
                           AND p2.id > ps.id)`);
};

exports.down = async function down(knex) {
  await knex.raw(
    `CREATE OR REPLACE VIEW user_membership_members AS
     SELECT DISTINCT ps.user_membership_id AS user_membership_id, psm.gym_id AS gym_id,
            psm.member_id AS member_id, psm.is_owner AS is_owner, psm.created_at AS created_at
       FROM product_sets ps
       JOIN product_set_members psm
         ON psm.root_product_set_id = ps.root_product_set_id AND psm.gym_id = ps.gym_id
      WHERE ps.user_membership_id IS NOT NULL`);
};
