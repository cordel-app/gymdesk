/**
 * #370: Align Sellable Item Status and Enrollment Status.
 *
 * `gym_charges.status` (active/inactive) already answers "is this Sellable
 * Item active?". This adds `enrollment_status` (public/staff_only) to answer
 * "who can enroll in it?" independently — mirroring the separation already
 * used by `membership_plans.lifecycle_status` / `enrollment_status`.
 *
 * `status = 'inactive'` always takes precedence over `enrollment_status` at
 * the application layer — see sellable-items.ts.
 */
exports.up = async (knex) => {
  const hasColumn = await knex.schema.hasColumn('gym_charges', 'enrollment_status');
  if (!hasColumn) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.string('enrollment_status', 20).notNullable().defaultTo('public');
    });

    // Existing inactive items default to the more restrictive enrollment value
    // so the migration never makes a previously-unavailable item look public.
    await knex.raw(`UPDATE gym_charges SET enrollment_status = 'staff_only' WHERE status = 'inactive'`);
  }

  const [[{ cnt }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gym_charges' AND CONSTRAINT_NAME = 'chk_gym_charges_enrollment_status'`,
  );
  if (cnt === 0) {
    await knex.raw(
      `ALTER TABLE gym_charges ADD CONSTRAINT chk_gym_charges_enrollment_status CHECK (enrollment_status IN ('public','staff_only'))`,
    );
  }
};

exports.down = async (knex) => {
  const [[{ cnt }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gym_charges' AND CONSTRAINT_NAME = 'chk_gym_charges_enrollment_status'`,
  );
  if (cnt > 0) {
    await knex.raw(`ALTER TABLE gym_charges DROP CONSTRAINT chk_gym_charges_enrollment_status`);
  }

  const hasColumn = await knex.schema.hasColumn('gym_charges', 'enrollment_status');
  if (hasColumn) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.dropColumn('enrollment_status');
    });
  }
};
