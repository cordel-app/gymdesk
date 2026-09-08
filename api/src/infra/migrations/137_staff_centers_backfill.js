/**
 * #440: backward-compatible data migration, same shape as #59's
 * 046_backfill_default_centers.js.
 *
 * Every non-deleted staff row that isn't already represented in
 * `staff_centers` is assigned a default center: its old single
 * `assigned_center_id` when it pointed at a still-active center, otherwise
 * its gym's sole active center (gyms with more than one center and a staff
 * row with no usable center are left for an admin to assign explicitly).
 *
 * Once backfilled, `staff.assigned_center_id` is redundant with
 * `staff_centers` and is dropped — nothing outside `staff.ts` ever read it
 * (unlike members, staff assignment was never used for center-scoped access
 * control), so no other call site needs updating.
 */
exports.up = async (knex) => {
  await knex.raw(`
    INSERT INTO staff_centers (gym_id, staff_id, center_id, is_default, assigned_at)
    SELECT s.gym_id, s.id, c.id, 1, UTC_TIMESTAMP()
    FROM staff s
    JOIN centers c ON c.id = s.assigned_center_id AND c.deleted_at IS NULL
    LEFT JOIN staff_centers sc ON sc.staff_id = s.id AND sc.deleted_at IS NULL
    WHERE s.deleted_at IS NULL AND s.assigned_center_id IS NOT NULL AND sc.staff_id IS NULL
    ON DUPLICATE KEY UPDATE is_default = 1, deleted_at = NULL
  `);

  await knex.raw(`
    INSERT INTO staff_centers (gym_id, staff_id, center_id, is_default, assigned_at)
    SELECT s.gym_id, s.id,
           (SELECT MIN(c.id) FROM centers c WHERE c.gym_id = s.gym_id AND c.deleted_at IS NULL),
           1, UTC_TIMESTAMP()
    FROM staff s
    LEFT JOIN staff_centers sc ON sc.staff_id = s.id AND sc.deleted_at IS NULL
    WHERE s.deleted_at IS NULL AND sc.staff_id IS NULL
      AND (SELECT COUNT(*) FROM centers c WHERE c.gym_id = s.gym_id AND c.deleted_at IS NULL) = 1
    ON DUPLICATE KEY UPDATE is_default = 1, deleted_at = NULL
  `);

  if (await knex.schema.hasColumn('staff', 'assigned_center_id')) {
    await knex.schema.alterTable('staff', (t) => {
      t.dropForeign(['assigned_center_id']);
      t.dropIndex(['assigned_center_id'], 'staff_center_index');
      t.dropColumn('assigned_center_id');
    });
  }
};

// One-directional data migration — same precedent as 046 (member centers
// backfill) and 009 (drop_legacy_plan_column): down() restores the column
// shape but not the pre-backfill data, since staff_centers is now the
// source of truth.
exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('staff', 'assigned_center_id'))) {
    await knex.schema.alterTable('staff', (t) => {
      t.integer('assigned_center_id').unsigned().nullable()
        .references('id').inTable('centers').onDelete('SET NULL');
      t.index(['assigned_center_id'], 'staff_center_index');
    });
  }
};
