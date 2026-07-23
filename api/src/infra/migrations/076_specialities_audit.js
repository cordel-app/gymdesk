/**
 * #161: Add status + audit columns (created_by, modified_at/by, deleted_at/by)
 * to the specialities table to align with the standard entity management pattern.
 */
exports.up = async (knex) => {
  const add = async (col, fn) => {
    if (!(await knex.schema.hasColumn('specialities', col))) {
      await knex.schema.alterTable('specialities', fn);
    }
  };

  await add('status', (t) => {
    t.string('status', 20).notNullable().defaultTo('active').after('description');
  });

  const [[{ cnt }]] = await knex.raw(`
    SELECT COUNT(*) AS cnt
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'specialities'
      AND CONSTRAINT_NAME = 'chk_specialities_status'
      AND CONSTRAINT_TYPE = 'CHECK'
  `);
  if (cnt === 0) {
    await knex.raw(
      "ALTER TABLE specialities ADD CONSTRAINT chk_specialities_status CHECK (status IN ('active','inactive'))",
    );
  }

  await add('created_by_membership_id', (t) => {
    t.integer('created_by_membership_id').unsigned().nullable()
      .references('id').inTable('gym_memberships').onDelete('SET NULL')
      .after('status');
  });

  await add('modified_at', (t) => {
    t.datetime('modified_at').nullable().after('created_by_membership_id');
  });

  await add('modified_by_membership_id', (t) => {
    t.integer('modified_by_membership_id').unsigned().nullable()
      .references('id').inTable('gym_memberships').onDelete('SET NULL')
      .after('modified_at');
  });

  await add('deleted_at', (t) => {
    t.datetime('deleted_at').nullable().after('modified_by_membership_id');
  });

  await add('deleted_by_membership_id', (t) => {
    t.integer('deleted_by_membership_id').unsigned().nullable()
      .references('id').inTable('gym_memberships').onDelete('SET NULL')
      .after('deleted_at');
  });
};

exports.down = async (knex) => {
  // Drop FK constraints before columns — MySQL blocks DROP COLUMN when a FK references them
  for (const fk of [
    'specialities_deleted_by_membership_id_foreign',
    'specialities_modified_by_membership_id_foreign',
    'specialities_created_by_membership_id_foreign',
  ]) {
    await knex.raw(`ALTER TABLE specialities DROP FOREIGN KEY \`${fk}\``).catch(() => {});
  }

  // chk_specialities_status is dropped automatically when the status column is dropped
  const cols = [
    'deleted_by_membership_id', 'deleted_at',
    'modified_by_membership_id', 'modified_at',
    'created_by_membership_id', 'status',
  ];
  for (const col of cols) {
    if (await knex.schema.hasColumn('specialities', col)) {
      await knex.schema.alterTable('specialities', (t) => t.dropColumn(col));
    }
  }
};
