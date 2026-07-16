/**
 * #59: additive, nullable center_id on the location-scoped entities that
 * already existed before Centers — rooms, class_sessions, bookings.
 * Nullable for now; flipped to NOT NULL by 047 once 046 backfills every row.
 *
 * Also backfills whichever audit columns (modified_at/modified_by_membership_id/
 * deleted_at) each table is missing, following the actor-typed FK precedent
 * from migrations 037-042 (e.g. 041_exercise_logs.js). class_sessions already
 * has an auto-managed `updated_at ON UPDATE CURRENT_TIMESTAMP` — it gets
 * modified_by_membership_id + deleted_at only, not a redundant modified_at.
 *
 * center_id uses ON DELETE RESTRICT, not SET NULL: 047 makes it NOT NULL once
 * backfilled, and MySQL rejects NOT NULL on a column with a SET NULL FK (the
 * constraint could never fire). RESTRICT also matches the real rule — centers.ts's
 * delete handler already blocks removing a center with dependent rows.
 */
exports.up = async (knex) => {
  for (const table of ['rooms', 'class_sessions', 'bookings']) {
    if (!(await knex.schema.hasColumn(table, 'center_id'))) {
      await knex.schema.alterTable(table, (t) => {
        t.integer('center_id').unsigned()
          .references('id').inTable('centers').onDelete('RESTRICT');
      });
    }
  }

  if (!(await knex.schema.hasColumn('rooms', 'modified_at'))) {
    await knex.schema.alterTable('rooms', (t) => { t.datetime('modified_at'); });
  }
  if (!(await knex.schema.hasColumn('bookings', 'modified_at'))) {
    await knex.schema.alterTable('bookings', (t) => { t.datetime('modified_at'); });
  }

  for (const table of ['rooms', 'class_sessions', 'bookings']) {
    if (!(await knex.schema.hasColumn(table, 'modified_by_membership_id'))) {
      await knex.schema.alterTable(table, (t) => {
        t.integer('modified_by_membership_id').unsigned()
          .references('id').inTable('gym_memberships').onDelete('SET NULL');
      });
    }
    if (!(await knex.schema.hasColumn(table, 'deleted_at'))) {
      await knex.schema.alterTable(table, (t) => { t.datetime('deleted_at'); });
    }
  }
};

exports.down = async (knex) => {
  for (const table of ['rooms', 'class_sessions', 'bookings']) {
    for (const fk of ['center_id', 'modified_by_membership_id']) {
      if (await knex.schema.hasColumn(table, fk)) {
        await knex.raw(`ALTER TABLE ${table} DROP FOREIGN KEY ${table}_${fk}_foreign`).catch(() => {});
      }
    }
    await knex.schema.alterTable(table, (t) => {
      t.dropColumn('center_id');
      t.dropColumn('modified_by_membership_id');
      t.dropColumn('deleted_at');
    }).catch(() => {});
  }
  await knex.schema.alterTable('rooms', (t) => t.dropColumn('modified_at')).catch(() => {});
  await knex.schema.alterTable('bookings', (t) => t.dropColumn('modified_at')).catch(() => {});
};
