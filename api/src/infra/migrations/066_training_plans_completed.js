/**
 * #112: Add 'completed' as a valid status for training_plans, enabling the
 * plan lifecycle: draft → active → completed (immutable). The existing
 * 'expired' status (used when a plan is superseded by a new one) remains.
 */
exports.up = async (knex) => {
  await knex.raw('ALTER TABLE training_plans DROP CHECK training_plans_status_check').catch(() => {});
  await knex.raw(
    "ALTER TABLE training_plans ADD CONSTRAINT training_plans_status_check " +
    "CHECK (status IN ('draft','active','expired','completed','deleted'))",
  );
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE training_plans DROP CHECK training_plans_status_check').catch(() => {});
  await knex.raw("UPDATE training_plans SET status = 'expired' WHERE status = 'completed'");
  await knex.raw(
    "ALTER TABLE training_plans ADD CONSTRAINT training_plans_status_check " +
    "CHECK (status IN ('draft','active','expired','deleted'))",
  );
};
