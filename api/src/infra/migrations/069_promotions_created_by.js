exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('promotions', 'created_by_membership_id'))) {
    await knex.schema.alterTable('promotions', (t) => {
      t.integer('created_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL')
        .after('stackable');
    });
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('promotions', 'created_by_membership_id')) {
    await knex.schema.alterTable('promotions', (t) => {
      t.dropForeign(['created_by_membership_id']);
      t.dropColumn('created_by_membership_id');
    });
  }
};
