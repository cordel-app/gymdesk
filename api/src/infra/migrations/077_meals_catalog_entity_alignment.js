/**
 * #162: Add lifecycle columns to dishes, sides, sauces to align with platform entity standards.
 * Adds: status, created_by_membership_id, modified_by_membership_id, deleted_at, deleted_by_membership_id.
 */

const TABLES = ['dishes', 'sides', 'sauces'];

exports.up = async (knex) => {
  for (const table of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'status'))) {
      await knex.schema.alterTable(table, (t) => {
        t.string('status', 20).notNullable().defaultTo('active').after('fat');
        t.integer('created_by_membership_id').unsigned().nullable()
          .references('id').inTable('gym_memberships').onDelete('SET NULL')
          .after('status');
        t.integer('modified_by_membership_id').unsigned().nullable()
          .references('id').inTable('gym_memberships').onDelete('SET NULL')
          .after('created_by_membership_id');
        t.datetime('deleted_at').nullable().after('modified_by_membership_id');
        t.integer('deleted_by_membership_id').unsigned().nullable()
          .references('id').inTable('gym_memberships').onDelete('SET NULL')
          .after('deleted_at');
      });
    }

    // Guard the CHECK constraint independently so a partial failure doesn't silently skip it
    const [existing] = await knex.raw(
      `SELECT CONSTRAINT_NAME FROM information_schema.CHECK_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ?`,
      [`chk_${table}_status`],
    );
    if (existing.length === 0) {
      await knex.raw(
        `ALTER TABLE \`${table}\` ADD CONSTRAINT chk_${table}_status CHECK (status IN ('active', 'deleted'))`,
      );
    }
  }
};

exports.down = async (knex) => {
  for (const table of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'status'))) continue;

    // Drop CHECK constraint
    await knex.raw(`ALTER TABLE \`${table}\` DROP CHECK chk_${table}_status`).catch(() => {});

    // Discover and drop FK constraints explicitly before dropping the columns
    const [fkRows] = await knex.raw(
      `SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         AND REFERENCED_TABLE_NAME IS NOT NULL
         AND COLUMN_NAME IN ('deleted_by_membership_id','modified_by_membership_id','created_by_membership_id')`,
      [table],
    );
    for (const { CONSTRAINT_NAME } of fkRows) {
      await knex.raw(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${CONSTRAINT_NAME}\``).catch(() => {});
    }

    await knex.schema.alterTable(table, (t) => {
      t.dropColumn('deleted_by_membership_id');
      t.dropColumn('deleted_at');
      t.dropColumn('modified_by_membership_id');
      t.dropColumn('created_by_membership_id');
      t.dropColumn('status');
    });
  }
};
