/**
 * #609: seed the flags two admin menu entries were already gated on but that
 * never existed — a missing key counts as enabled, so Professional Services and
 * Assigned Plans could not be hidden and didn't appear on Cordel → Feature Flags.
 *
 * #610: split Taxes off `financials.gym_charges` (shared with Sellable Items)
 * into its own `financials.taxes`, seeded with the current gym_charges value so
 * nothing changes on deploy.
 */

exports.up = async (knex) => {
  await knex.raw(
    `INSERT IGNORE INTO feature_flags (feature_key, enabled, updated_at) VALUES
       ('organization.professional_services', 1, UTC_TIMESTAMP()),
       ('financials.assigned_plans', 1, UTC_TIMESTAMP())`,
  );
  await knex.raw(
    `INSERT IGNORE INTO feature_flags (feature_key, enabled, updated_at)
     SELECT 'financials.taxes',
            COALESCE((SELECT enabled FROM feature_flags WHERE feature_key = 'financials.gym_charges'), 1),
            UTC_TIMESTAMP()`,
  );
};

exports.down = async (knex) => {
  await knex.raw(
    `DELETE FROM feature_flags
     WHERE feature_key IN ('organization.professional_services', 'financials.assigned_plans', 'financials.taxes')`,
  );
};
