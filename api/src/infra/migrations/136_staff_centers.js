/**
 * #440: Multi-center association for Staff — a Staff member may be assigned
 * to one or multiple Centers, with exactly one designated as the default.
 * Mirrors `member_centers` (#59): PK (staff_id, center_id), a generated-column
 * unique index enforces "at most one active default center per staff member"
 * as defense-in-depth on top of the app-level transaction in staff-centers.ts.
 *
 * Every step is guarded independently — DDL is non-transactional in MySQL,
 * so a retry after a partial failure must be able to resume.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('staff_centers'))) {
    await knex.schema.createTable('staff_centers', (t) => {
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('staff_id').unsigned().notNullable()
        .references('id').inTable('staff').onDelete('CASCADE');
      t.integer('center_id').unsigned().notNullable()
        .references('id').inTable('centers').onDelete('CASCADE');
      t.boolean('is_default').notNullable().defaultTo(false);
      t.datetime('assigned_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.integer('assigned_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.datetime('modified_at').nullable();
      t.integer('modified_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('deleted_at').nullable();
      t.primary(['staff_id', 'center_id']);
      t.index(['gym_id', 'center_id'], 'staff_centers_center_index');
    });
  }

  if (!(await knex.schema.hasColumn('staff_centers', 'default_key'))) {
    await knex.raw(
      "ALTER TABLE staff_centers ADD COLUMN default_key INT UNSIGNED " +
      "GENERATED ALWAYS AS (IF(is_default = 1 AND deleted_at IS NULL, staff_id, NULL)) VIRTUAL",
    );
    await knex.raw(
      "ALTER TABLE staff_centers ADD UNIQUE KEY staff_centers_one_default_unique (default_key)",
    );
  }
};

exports.down = async (knex) => knex.schema.dropTableIfExists('staff_centers');
