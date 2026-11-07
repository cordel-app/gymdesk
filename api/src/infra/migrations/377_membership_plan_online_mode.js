/**
 * #2420: On-line becomes an access mode of its own. Widens the mode CHECK and
 * converts plans whose only selection was On-line (flag set, no physical
 * center rows, specific_centers). A plan that combined On-line with physical
 * centers keeps both (`online_access` stays 1) rather than silently dropping
 * either. Re-entrant.
 */
exports.up = async (knex) => {
  await knex.raw('ALTER TABLE membership_plans DROP CONSTRAINT chk_membership_plans_center_access_mode');
  await knex.raw(
    `ALTER TABLE membership_plans ADD CONSTRAINT chk_membership_plans_center_access_mode
       CHECK (center_access_mode IN ('specific_centers','all_centers','member_default_center','online'))`);
  await knex.raw(
    `UPDATE membership_plans mp SET mp.center_access_mode = 'online', mp.online_access = 0
      WHERE mp.center_access_mode = 'specific_centers' AND mp.online_access = 1
        AND NOT EXISTS (SELECT 1 FROM membership_plan_centers mpc WHERE mpc.membership_plan_id = mp.id)`);
};

exports.down = async (knex) => {
  await knex.raw(
    `UPDATE membership_plans SET center_access_mode = 'specific_centers', online_access = 1 WHERE center_access_mode = 'online'`);
  await knex.raw('ALTER TABLE membership_plans DROP CONSTRAINT chk_membership_plans_center_access_mode');
  await knex.raw(
    `ALTER TABLE membership_plans ADD CONSTRAINT chk_membership_plans_center_access_mode
       CHECK (center_access_mode IN ('specific_centers','all_centers','member_default_center'))`);
};
