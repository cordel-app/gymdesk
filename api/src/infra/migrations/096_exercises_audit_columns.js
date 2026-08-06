exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('exercises', 'created_by'))) {
    await knex.schema.alterTable('exercises', (t) => {
      t.integer('created_by').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasColumn('exercises', 'modified_at'))) {
    await knex.schema.alterTable('exercises', (t) => {
      // NULL means never modified after creation
      t.datetime('modified_at').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('exercises', 'modified_by'))) {
    await knex.schema.alterTable('exercises', (t) => {
      t.integer('modified_by').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasColumn('exercises', 'deleted_by'))) {
    await knex.schema.alterTable('exercises', (t) => {
      t.integer('deleted_by').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }
};

exports.down = async (knex) => {
  // Dropping the column in MySQL 8 (InnoDB) auto-drops the associated FK constraint.
  for (const col of ['deleted_by', 'modified_by', 'modified_at', 'created_by']) {
    if (await knex.schema.hasColumn('exercises', col)) {
      await knex.schema.alterTable('exercises', (t) => t.dropColumn(col));
    }
  }
};
