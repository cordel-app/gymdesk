/**
 * #2383: a Membership Plan's center access is one of three modes.
 * `specific_centers` (the default, and what every existing plan keeps — its
 * `membership_plan_centers` rows are untouched, an empty set still meaning
 * "no restriction" exactly as before), `all_centers` (a persistent rule that
 * also covers centers created later, no rows) and `member_default_center`
 * (resolved from the Member's default center, no rows). Re-entrant.
 */
const hasColumn = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'membership_plans' AND COLUMN_NAME = 'center_access_mode' LIMIT 1`);
  return rows.length > 0;
};

exports.up = async (knex) => {
  if (await hasColumn(knex)) return;
  await knex.raw(
    `ALTER TABLE membership_plans
       ADD COLUMN center_access_mode VARCHAR(24) NOT NULL DEFAULT 'specific_centers',
       ADD CONSTRAINT chk_membership_plans_center_access_mode
         CHECK (center_access_mode IN ('specific_centers','all_centers','member_default_center'))`);
};

exports.down = async (knex) => {
  if (!(await hasColumn(knex))) return;
  await knex.raw('ALTER TABLE membership_plans DROP CONSTRAINT chk_membership_plans_center_access_mode');
  await knex.raw('ALTER TABLE membership_plans DROP COLUMN center_access_mode');
};
