/**
 * #487 (stage 1): Configurable Membership Fee Benefit for Period Benefits
 *
 * Adds nullable action/value columns to promotion_period_benefits, mirroring
 * promotion_charge_benefits' action/value pattern (see 092/102). Stage 1 is
 * display/config only — validated by the API but with zero effect on real
 * billing (that's stage 2/3, a separate future PR). Both columns are
 * nullable with no backfill, so existing (non-Membership-Fee) period
 * benefit rows remain valid and unaffected.
 */

exports.up = async (knex) => {
  const hasAction = await knex.schema.hasColumn('promotion_period_benefits', 'action');
  if (!hasAction) {
    await knex.schema.alterTable('promotion_period_benefits', (t) => {
      t.string('action', 30).nullable().after('duration_months');
      t.decimal('value', 10, 2).nullable().after('action');
    });
  }

  await knex.raw('ALTER TABLE promotion_period_benefits DROP CHECK ppb_action_check').catch(() => {});
  await knex.raw(
    "ALTER TABLE promotion_period_benefits ADD CONSTRAINT ppb_action_check " +
    "CHECK (action IS NULL OR action IN ('no_benefit','waive','percentage_discount','fixed_discount','fixed_price'))",
  );
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE promotion_period_benefits DROP CHECK ppb_action_check').catch(() => {});

  const hasAction = await knex.schema.hasColumn('promotion_period_benefits', 'action');
  if (hasAction) {
    await knex.schema.alterTable('promotion_period_benefits', (t) => {
      t.dropColumn('value');
      t.dropColumn('action');
    });
  }
};
