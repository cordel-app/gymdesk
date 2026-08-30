/**
 * #269: Activity Types v2.
 * - Add audit columns + soft-delete to activity_types
 * - Add default_center_id FK → centers
 * - Add timezone to gyms (IANA timezone string, default Europe/Madrid)
 */
exports.up = async (knex) => {
  // ── gyms.timezone ────────────────────────────────────────────────────────────
  if (!(await knex.schema.hasColumn('gyms', 'timezone'))) {
    await knex.schema.alterTable('gyms', (t) => {
      t.string('timezone', 64).notNullable().defaultTo('Europe/Madrid');
    });
  }

  // ── activity_types: default_center_id ────────────────────────────────────────
  if (!(await knex.schema.hasColumn('activity_types', 'default_center_id'))) {
    await knex.schema.alterTable('activity_types', (t) => {
      t.integer('default_center_id').unsigned().nullable()
        .references('id').inTable('centers').onDelete('SET NULL');
    });
  }

  // ── activity_types: audit + soft-delete ──────────────────────────────────────
  if (!(await knex.schema.hasColumn('activity_types', 'created_by_membership_id'))) {
    await knex.schema.alterTable('activity_types', (t) => {
      t.integer('created_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasColumn('activity_types', 'modified_at'))) {
    await knex.schema.alterTable('activity_types', (t) => {
      t.datetime('modified_at').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('activity_types', 'modified_by_membership_id'))) {
    await knex.schema.alterTable('activity_types', (t) => {
      t.integer('modified_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasColumn('activity_types', 'deleted_at'))) {
    await knex.schema.alterTable('activity_types', (t) => {
      t.datetime('deleted_at').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('activity_types', 'deleted_by_membership_id'))) {
    await knex.schema.alterTable('activity_types', (t) => {
      t.integer('deleted_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }
};

exports.down = async (knex) => {
  const fkCols = [
    'deleted_by_membership_id',
    'created_by_membership_id',
    'modified_by_membership_id',
    'default_center_id',
  ];
  for (const col of fkCols) {
    if (await knex.schema.hasColumn('activity_types', col)) {
      await knex.schema.alterTable('activity_types', (t) => {
        t.dropForeign([col]);
        t.dropColumn(col);
      });
    }
  }
  for (const col of ['deleted_at', 'modified_at']) {
    if (await knex.schema.hasColumn('activity_types', col)) {
      await knex.schema.alterTable('activity_types', (t) => t.dropColumn(col));
    }
  }
  if (await knex.schema.hasColumn('gyms', 'timezone')) {
    await knex.schema.alterTable('gyms', (t) => t.dropColumn('timezone'));
  }
};
