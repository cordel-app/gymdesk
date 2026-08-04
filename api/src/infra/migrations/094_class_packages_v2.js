/**
 * #220: Add audit columns + description + soft-delete to class_packages.
 */
exports.up = async (knex) => {
  const has = (col) => knex.schema.hasColumn('class_packages', col);

  if (!(await has('description'))) {
    await knex.schema.alterTable('class_packages', (t) => {
      t.text('description').nullable();
    });
  }

  if (!(await has('notes'))) {
    await knex.schema.alterTable('class_packages', (t) => {
      t.text('notes').nullable();
    });
  }

  if (!(await has('created_by_membership_id'))) {
    await knex.schema.alterTable('class_packages', (t) => {
      t.integer('created_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }

  if (!(await has('modified_at'))) {
    await knex.schema.alterTable('class_packages', (t) => {
      t.datetime('modified_at').nullable();
    });
  }

  if (!(await has('modified_by_membership_id'))) {
    await knex.schema.alterTable('class_packages', (t) => {
      t.integer('modified_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }

  if (!(await has('deleted_at'))) {
    await knex.schema.alterTable('class_packages', (t) => {
      t.datetime('deleted_at').nullable();
    });
  }

  if (!(await has('deleted_by_membership_id'))) {
    await knex.schema.alterTable('class_packages', (t) => {
      t.integer('deleted_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }
};

exports.down = async (knex) => {
  const has = (col) => knex.schema.hasColumn('class_packages', col);
  for (const col of [
    'deleted_by_membership_id', 'deleted_at',
    'modified_by_membership_id', 'modified_at',
    'created_by_membership_id', 'notes', 'description',
  ]) {
    if (await has(col)) {
      await knex.schema.alterTable('class_packages', (t) => t.dropColumn(col));
    }
  }
};
