/**
 * #74: Add created_by and deleted_by audit columns to centers.
 * The Details dialog requires these; previously only modified_by existed.
 */
exports.up = async (knex) => {
  const hasCreated = await knex.schema.hasColumn('centers', 'created_by_membership_id');
  const hasDeleted = await knex.schema.hasColumn('centers', 'deleted_by_membership_id');
  if (!hasCreated) {
    await knex.schema.alterTable('centers', (t) => {
      t.integer('created_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }
  if (!hasDeleted) {
    await knex.schema.alterTable('centers', (t) => {
      t.integer('deleted_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('centers', 'deleted_by_membership_id')) {
    await knex.schema.alterTable('centers', (t) => t.dropColumn('deleted_by_membership_id'));
  }
  if (await knex.schema.hasColumn('centers', 'created_by_membership_id')) {
    await knex.schema.alterTable('centers', (t) => t.dropColumn('created_by_membership_id'));
  }
};
