/**
 * #211: Refine Plan Lifecycle and Enrollment Status values.
 *
 * Lifecycle: draft → active → paused → inactive  (archived renamed to inactive)
 * Enrollment: public | staff_only | closed        (open → public, enrollment-paused → closed, add staff_only)
 *
 * The DB has existing CHECK constraints from an untracked source:
 *   mp_lifecycle_status_check  CHECK (lifecycle_status IN ('draft','active','archived'))
 *   mp_enrollment_status_check CHECK (enrollment_status IN ('open','closed'))
 * We drop those first, migrate data, then add new constraints with updated value sets.
 *
 * NOTE (lossy rollback): The down migration cannot distinguish plans that were
 * legitimately `enrollment_status = 'closed'` before this migration from plans
 * that had `enrollment_status = 'paused'` (renamed here). The down() therefore
 * only safely reverses 'public' → 'open' and 'inactive' → 'archived'. If rollback
 * is ever needed in practice it must be validated manually.
 */
exports.up = async (knex) => {
  // Drop old constraints (names from untracked migration; .catch in case absent)
  await knex.raw(`ALTER TABLE membership_plans DROP CONSTRAINT mp_lifecycle_status_check`).catch(() => {});
  await knex.raw(`ALTER TABLE membership_plans DROP CONSTRAINT mp_enrollment_status_check`).catch(() => {});

  // Lifecycle: archived → inactive
  await knex.raw(`UPDATE membership_plans SET lifecycle_status = 'inactive' WHERE lifecycle_status = 'archived'`);

  // Enrollment: open → public
  await knex.raw(`UPDATE membership_plans SET enrollment_status = 'public' WHERE enrollment_status = 'open'`);

  // Enrollment: paused → closed (paused-enrollment is equivalent to closed in new model)
  await knex.raw(`UPDATE membership_plans SET enrollment_status = 'closed' WHERE enrollment_status = 'paused'`);

  // Add new constraints with updated value sets
  await knex.raw(`ALTER TABLE membership_plans ADD CONSTRAINT chk_mp_lifecycle_status CHECK (lifecycle_status IN ('draft','active','paused','inactive'))`).catch(() => {});
  await knex.raw(`ALTER TABLE membership_plans ADD CONSTRAINT chk_mp_enrollment_status CHECK (enrollment_status IN ('public','staff_only','closed'))`).catch(() => {});
};

exports.down = async (knex) => {
  // Drop new constraints
  await knex.raw(`ALTER TABLE membership_plans DROP CONSTRAINT chk_mp_lifecycle_status`).catch(() => {});
  await knex.raw(`ALTER TABLE membership_plans DROP CONSTRAINT chk_mp_enrollment_status`).catch(() => {});

  // NOTE: 'closed' rows cannot be fully reversed — some were originally 'paused'
  // (renamed by this migration) and some were legitimately 'closed' before it ran.
  // Only the public → open and inactive → archived renames are safely reversible.
  await knex.raw(`UPDATE membership_plans SET enrollment_status = 'open' WHERE enrollment_status = 'public'`);
  await knex.raw(`UPDATE membership_plans SET lifecycle_status = 'archived' WHERE lifecycle_status = 'inactive'`);

  // Restore old constraints
  await knex.raw(`ALTER TABLE membership_plans ADD CONSTRAINT mp_lifecycle_status_check CHECK (lifecycle_status IN ('draft','active','archived'))`).catch(() => {});
  await knex.raw(`ALTER TABLE membership_plans ADD CONSTRAINT mp_enrollment_status_check CHECK (enrollment_status IN ('open','closed'))`).catch(() => {});
};
