/**
 * #369: Add "4 Weeks" as a supported billing_frequency for Sellable Items.
 *
 * `4 Weeks` must represent a fixed 28-day period, not a calendar month — it is
 * stored as its own frequency value ('four_weeks') rather than reusing 'month'.
 * billing_frequency on gym_charges is a descriptive label only (actual validity
 * is tracked separately via validity_days), so this migration only widens the
 * CHECK constraint; no data backfill is required.
 */
exports.up = async (knex) => {
  await knex.raw(
    'ALTER TABLE gym_charges DROP CHECK gym_charges_billing_frequency_check',
  ).catch(() => {});
  await knex.raw(
    'ALTER TABLE gym_charges ADD CONSTRAINT gym_charges_billing_frequency_check ' +
    "CHECK (billing_frequency IS NULL OR billing_frequency IN ('once','per_session','four_weeks','week','month','year'))",
  );
};

exports.down = async (knex) => {
  await knex('gym_charges').where({ billing_frequency: 'four_weeks' }).update({ billing_frequency: null });
  await knex.raw(
    'ALTER TABLE gym_charges DROP CHECK gym_charges_billing_frequency_check',
  ).catch(() => {});
  await knex.raw(
    'ALTER TABLE gym_charges ADD CONSTRAINT gym_charges_billing_frequency_check ' +
    "CHECK (billing_frequency IS NULL OR billing_frequency IN ('once','per_session','week','month','year'))",
  );
};
