/**
 * #1325 PR 3a — the operational assignment a ProductSet version projects.
 *
 * Until the screens and readers that still ask `user_memberships` for a
 * member's plan have moved to ProductSets, an Active version that contains a
 * Membership Plan is *projected* onto one operational `user_memberships` row
 * (api/src/api/product-set-projection.ts), so access, eligibility, the Assigned
 * Plan card and `GET /me/membership` keep answering. The link is deliberately
 * **ProductSet → assignment** and not the other way: `user_memberships` carries
 * no ProductSet reference (the ticket's decision), and the projection is the
 * only writer of that pointer.
 *
 * SET NULL: removing an assignment never removes a ProductSet version.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('product_sets', 'user_membership_id'))) {
    await knex.raw(`ALTER TABLE product_sets
      ADD COLUMN user_membership_id INT UNSIGNED NULL,
      ADD KEY product_sets_user_membership_index (user_membership_id),
      ADD CONSTRAINT product_sets_user_membership_fk FOREIGN KEY (user_membership_id)
        REFERENCES user_memberships (id) ON DELETE SET NULL`);
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('product_sets', 'user_membership_id')) {
    await knex.raw(`ALTER TABLE product_sets
      DROP FOREIGN KEY product_sets_user_membership_fk,
      DROP KEY product_sets_user_membership_index,
      DROP COLUMN user_membership_id`);
  }
};
