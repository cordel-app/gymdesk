/**
 * #369: Add "4 Weeks" as a supported billing_frequency for Sellable Items.
 *
 * `4 Weeks` must represent a fixed 28-day period, not a calendar month — it is
 * stored as its own frequency value ('four_weeks') rather than reusing 'month'.
 * billing_frequency on gym_charges is a descriptive label only (actual validity
 * is tracked separately via validity_days), so this migration only widens the
 * CHECK constraint; no data backfill is required.
 *
 * Follows the same guarded drop-and-recreate pattern as migration 102 (which
 * added 'per_session' the same way): MySQL's DROP CHECK has no IF EXISTS, so
 * we check information_schema first, and DROP+ADD are combined into a single
 * ALTER TABLE statement so the constraint is never briefly absent mid-migration.
 */

const constraintExists = (knex, name) =>
  knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gym_charges' AND CONSTRAINT_NAME = ?`,
    [name],
  ).then(([rows]) => rows[0].cnt > 0);

async function setBillingFrequencyCheck(knex, values) {
  const check = `CHECK (billing_frequency IS NULL OR billing_frequency IN (${values.map((v) => `'${v}'`).join(',')}))`;
  const hasConstraint = await constraintExists(knex, 'gym_charges_billing_frequency_check');
  if (hasConstraint) {
    await knex.raw(`
      ALTER TABLE gym_charges
        DROP CHECK gym_charges_billing_frequency_check,
        ADD CONSTRAINT gym_charges_billing_frequency_check ${check}
    `);
  } else {
    await knex.raw(`ALTER TABLE gym_charges ADD CONSTRAINT gym_charges_billing_frequency_check ${check}`);
  }
}

exports.up = async (knex) => {
  await setBillingFrequencyCheck(knex, ['once', 'per_session', 'four_weeks', 'week', 'month', 'year']);
};

exports.down = async (knex) => {
  // Irreversible: rows using 'four_weeks' are nulled out here and cannot be
  // distinguished from originally-NULL rows if up() is re-applied later.
  await knex('gym_charges').where({ billing_frequency: 'four_weeks' }).update({ billing_frequency: null });
  await setBillingFrequencyCheck(knex, ['once', 'per_session', 'week', 'month', 'year']);
};
