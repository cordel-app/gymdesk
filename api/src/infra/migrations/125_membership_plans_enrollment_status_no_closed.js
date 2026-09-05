/**
 * #370 (amendment): Align Plan Enrollment Status with Sellable Items.
 *
 * `membership_plans.enrollment_status` drops `closed` — the model now mirrors
 * `gym_charges.enrollment_status` (#370/#386): only `public` and `staff_only`.
 * `lifecycle_status` (draft/active/paused/inactive) already answers "is this
 * Plan active?" independently — `enrollment_status` only answers "who can
 * enroll in it?", so `closed` was a redundant third state.
 *
 * Explicit mapping (per ticket): every existing `closed` Plan becomes
 * `public`. Do not interpret `closed` as `staff_only` — `lifecycle_status`
 * is what kept (and still keeps) an inactive/draft/paused Plan unavailable,
 * not `enrollment_status`.
 */
exports.up = async (knex) => {
  await knex.raw(`UPDATE membership_plans SET enrollment_status = 'public' WHERE enrollment_status = 'closed'`);

  // Change the default first — 'staff_only' is valid under both the old and
  // new CHECK constraint, so there is no window where a default-relying
  // insert could violate whichever constraint is currently active.
  await knex.raw(`ALTER TABLE membership_plans ALTER enrollment_status SET DEFAULT 'staff_only'`);

  await knex.raw(`ALTER TABLE membership_plans DROP CONSTRAINT chk_mp_enrollment_status`).catch(() => {});
  await knex.raw(`ALTER TABLE membership_plans ADD CONSTRAINT chk_mp_enrollment_status CHECK (enrollment_status IN ('public','staff_only'))`);
};

exports.down = async (knex) => {
  // Widen the constraint back to allow 'closed' before setting it as the
  // default, so the default is never rejected by whichever constraint is
  // currently active.
  await knex.raw(`ALTER TABLE membership_plans DROP CONSTRAINT chk_mp_enrollment_status`).catch(() => {});
  await knex.raw(`ALTER TABLE membership_plans ADD CONSTRAINT chk_mp_enrollment_status CHECK (enrollment_status IN ('public','staff_only','closed'))`);

  await knex.raw(`ALTER TABLE membership_plans ALTER enrollment_status SET DEFAULT 'closed'`);

  // NOTE (lossy rollback): plans migrated 'closed' → 'public' by up() cannot be
  // distinguished from plans that were already legitimately 'public'.
};
